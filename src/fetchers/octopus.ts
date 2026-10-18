import axios from 'axios';
import { getDatabase } from '../database/schema.js';
import { calculatePriceLevel, updatePriceLevelForForecast } from '../database/colors.js';
import { setCachedData, recordCacheMiss } from '../database/cache.js';
import { BACKFILL_THRESHOLD_DAYS, HISTORY_DAYS, priceHistoryDays, recordPriceHistory } from '../database/history.js';

const OCTOPUS_API_URL = 'https://api.octopus.energy/v1/products';
const CACHE_TTL_MINUTES = 60; // Cache for 1 hour - rates are published daily
/** Older rates are only kept in the history table, not in the current forecast */
const FORECAST_LOOKBACK_SECONDS = 2 * 24 * 3600;
/** Follow at most this many pages of results (1500 rates each) */
const MAX_PAGES = 3;
const RETRY_CONFIG = {
  maxRetries: 3,
  backoffMs: 2000,
};

interface OctopusRate {
  valid_from: string;
  valid_to: string;
  value_inc_vat: number;
  value_exc_vat: number;
}

interface OctopusProduct {
  results: OctopusRate[];
}

export async function fetchOctopusAgileRates(
  apiKey: string,
  productCode: string = 'AGILE-22-11-01', // Default Agile tariff code
  regionCode: string = 'A' // Default region A (Eastern England)
): Promise<void> {
  const db = await getDatabase();

  // Check if source exists
  let sourceId = await db.get(
    "SELECT id FROM price_sources WHERE id = 'octopus'",
  );

  if (!sourceId) {
    const now = Math.floor(Date.now() / 1000);
    await db.run(
      `INSERT INTO price_sources (id, name, priority, enabled, api_key, metadata, created_at, updated_at)
       VALUES ('octopus', 'Octopus Agile', 2, 1, ?, ?, ?, ?)`,
      [
        encryptApiKey(apiKey),
        JSON.stringify({ productCode, regionCode }),
        now,
        now,
      ]
    );
  }

  let attempt = 0;
  while (attempt < RETRY_CONFIG.maxRetries) {
    try {
      // Fill the history with a month of past rates when it is short (e.g. first run)
      const backfill = (await priceHistoryDays('octopus')) < BACKFILL_THRESHOLD_DAYS;
      const periodFrom = backfill ? new Date(Date.now() - HISTORY_DAYS * 24 * 3600 * 1000).toISOString() : undefined;
      const rates = await queryOctopusAPI(apiKey, productCode, regionCode, periodFrom);

      if (!rates) {
        throw new Error('No rates data returned from Octopus API');
      }

      const halfHourly = rates.filter(isHalfHourlyRate);
      await recordPriceHistory(
        'octopus',
        'GBP',
        2,
        halfHourly.map((rate) => ({
          periodStart: Math.floor(new Date(rate.valid_from).getTime() / 1000),
          periodEnd: Math.floor(new Date(rate.valid_to).getTime() / 1000),
          price: Math.round(rate.value_inc_vat * 100),
        }))
      );
      if (backfill) {
        console.log(`Backfilled Octopus price history with ${halfHourly.length} rates`);
      }

      const recentCutoff = Date.now() - FORECAST_LOOKBACK_SECONDS * 1000;
      await storePriceForecast(
        rates.filter((rate) => new Date(rate.valid_to).getTime() > recentCutoff),
        productCode,
        regionCode
      );
      return;
    } catch (error) {
      attempt++;
      if (attempt >= RETRY_CONFIG.maxRetries) {
        console.error('Octopus API failed after retries:', error);
        await recordCacheMiss(`octopus-rates-${regionCode}`, 'octopus');
        throw error;
      }
      const delayMs = RETRY_CONFIG.backoffMs * Math.pow(2, attempt - 1);
      console.warn(
        `Octopus fetch attempt ${attempt} failed, retrying in ${delayMs}ms:`,
        error
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function queryOctopusAPI(
  apiKey: string,
  productCode: string,
  regionCode: string,
  periodFrom?: string
): Promise<OctopusRate[] | null> {
  // Use the public endpoint that doesn't require authentication
  const tariffCode = `E-1R-${productCode}-${regionCode}`;
  let url: string | null = `https://api.octopus.energy/v1/products/${productCode}/electricity-tariffs/${tariffCode}/standard-unit-rates/`;
  const params: Record<string, string | number> | undefined = periodFrom
    ? { period_from: periodFrom, page_size: 1500 }
    : undefined;

  // A backfill can span more than one page
  const results: OctopusRate[] = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const response: { data: { results?: OctopusRate[]; next?: string | null } } = await axios.get(url, {
      timeout: 30000,
      params: page === 0 ? params : undefined,
    });
    if (!response.data?.results) {
      throw new Error('Invalid Octopus API response format');
    }
    results.push(...response.data.results);
    url = periodFrom ? response.data.next ?? null : null;
  }
  return results;
}

function isHalfHourlyRate(rate: OctopusRate) {
  return new Date(rate.valid_to).getTime() - new Date(rate.valid_from).getTime() === 30 * 60 * 1000;
}

async function storePriceForecast(
  rates: OctopusRate[],
  productCode: string,
  regionCode: string
): Promise<void> {
  const db = await getDatabase();
  const now = Math.floor(Date.now() / 1000);

  // Delete old forecasts from this source to avoid duplicates
  await db.run('DELETE FROM commodity_price_forecasts WHERE source_id = ?', ['octopus']);

  if (rates.length === 0) {
    throw new Error('No rates found in Octopus response');
  }

  // Octopus returns prices in pence per kWh
  const currency = 'GBP';
  const decimals = 2; // pence = 0.01 GBP (value_inc_vat * 100 gives pence units)
  const tariffUnit = 'kWh';
  const periodMinutes = 30;

  // Calculate valid_until: rates are valid for at least 24 hours from fetch time
  const validUntil = now + (24 * 3600); // Valid for 24 hours

  // Insert forecast record
  const forecastId = (
    await db.run(
      `INSERT INTO commodity_price_forecasts
       (source_id, currency, decimals, tariff_unit, period_minutes, fetched_at, valid_until, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['octopus', currency, decimals, tariffUnit, periodMinutes, now, validUntil, now]
    )
  ).lastID as number;

  // Insert individual rate points
  // Filter for actual half-hourly rates (some Octopus responses include other data)
  const halfHourlyRates = rates.filter((rate) => {
    const start = new Date(rate.valid_from);
    const end = new Date(rate.valid_to);
    const durationMs = end.getTime() - start.getTime();
    return durationMs === 30 * 60 * 1000; // 30 minutes in milliseconds
  });

  for (const rate of halfHourlyRates) {
    const periodStart = Math.floor(new Date(rate.valid_from).getTime() / 1000);
    const periodEnd = Math.floor(new Date(rate.valid_to).getTime() / 1000);

    // Octopus returns price in pence per kWh (with VAT)
    // Multiply by 10 to convert from pence/kWh to 0.1 pence units (to fit in integer)
    // OR keep in pence and store as integer
    const price = Math.round(rate.value_inc_vat * 100); // Convert to smallest unit (1/100 pence)

    const priceLevel = await calculatePriceLevel(price, currency, decimals, tariffUnit);

    await db.run(
      `INSERT INTO commodity_prices
       (forecast_id, period_start, period_end, price, price_level, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [forecastId, periodStart, periodEnd, price, priceLevel, now]
    );
  }

  // Update color levels for all prices in this forecast
  await updatePriceLevelForForecast(forecastId);

  // Cache metadata
  await setCachedData(
    `octopus-rates-${regionCode}`,
    'octopus',
    {
      forecastId,
      rateCount: halfHourlyRates.length,
      productCode,
      regionCode,
    },
    CACHE_TTL_MINUTES
  );

  console.log(
    `Stored ${halfHourlyRates.length} Octopus Agile rate points for region ${regionCode}`
  );

  // Update price server if available
  try {
    const priceServer = (globalThis as any).__priceServer;
    if (priceServer) {
      // Find current and upcoming prices
      const now = Math.floor(Date.now() / 1000);
      const currentRate = halfHourlyRates.find(rate => {
        const start = Math.floor(new Date(rate.valid_from).getTime() / 1000);
        const end = Math.floor(new Date(rate.valid_to).getTime() / 1000);
        return start <= now && now < end;
      });

      if (currentRate) {
        const price = Math.round(currentRate.value_inc_vat * 100);
        const priceLevel = await calculatePriceLevel(price, currency, decimals, tariffUnit);
        // Get actual period times from Octopus API (convert to Unix timestamps)
        const periodStart = Math.floor(new Date(currentRate.valid_from).getTime() / 1000);
        const periodEnd = Math.floor(new Date(currentRate.valid_to).getTime() / 1000);
        // GBP = 826 (ISO 4217), decimals=2 means 0.01 GBP units (pence)
        await priceServer.setCurrentPrice(price, priceLevel, periodStart, periodEnd, 826, decimals);
      }

      // Build forecast from the current period onwards (Octopus returns newest first)
      const forecast = halfHourlyRates
        .map(rate => ({
          periodStart: Math.floor(new Date(rate.valid_from).getTime() / 1000),
          periodEnd: Math.floor(new Date(rate.valid_to).getTime() / 1000),
          price: Math.round(rate.value_inc_vat * 100),
          priceLevel: 0,
        }))
        .filter(entry => entry.periodEnd > now)
        .sort((a, b) => a.periodStart - b.periodStart);

      if (forecast.length > 0) {
        await priceServer.setPriceForecast(forecast);
      }
    }
  } catch (e) {
    console.warn('Error updating price server from Octopus data:', e);
  }
}

// Simple encryption placeholder - in production, use proper encryption
function encryptApiKey(apiKey: string): string {
  // TODO: Implement proper encryption (e.g., with crypto module)
  // For now, just base64 encode as placeholder
  return Buffer.from(apiKey).toString('base64');
}

export function decryptApiKey(encrypted: string): string {
  // TODO: Implement proper decryption
  return Buffer.from(encrypted, 'base64').toString('utf-8');
}
