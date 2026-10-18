import axios from 'axios';
import { getDatabase } from '../database/schema.js';
import { calculatePriceLevel, updatePriceLevelForForecast } from '../database/colors.js';
import { setCachedData, recordCacheMiss } from '../database/cache.js';
import { priceLevelNumber } from '../price-server/schedule.js';

const OCTOPUS_API_URL = 'https://api.octopus.energy/v1/products';
const CACHE_TTL_MINUTES = 60; // Cache for 1 hour - rates are published daily
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
      const rates = await queryOctopusAPI(apiKey, productCode, regionCode);

      if (!rates) {
        throw new Error('No rates data returned from Octopus API');
      }

      await storePriceForecast(rates, productCode, regionCode);
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
  regionCode: string
): Promise<OctopusRate[] | null> {
  // Use the public endpoint that doesn't require authentication
  const tariffCode = `E-1R-${productCode}-${regionCode}`;
  const url = `https://api.octopus.energy/v1/products/${productCode}/electricity-tariffs/${tariffCode}/standard-unit-rates/`;

  const response = await axios.get(url, {
    timeout: 10000,
  });

  if (!response.data?.results) {
    throw new Error('Invalid Octopus API response format');
  }

  return response.data.results;
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

  // Update price server if available; it advances CurrentPrice through the schedule itself
  try {
    const priceServer = (globalThis as any).__priceServer;
    if (priceServer) {
      const entries = [];
      for (const rate of halfHourlyRates) {
        const price = Math.round(rate.value_inc_vat * 100);
        entries.push({
          periodStart: Math.floor(new Date(rate.valid_from).getTime() / 1000),
          periodEnd: Math.floor(new Date(rate.valid_to).getTime() / 1000),
          price,
          priceLevel: priceLevelNumber(await calculatePriceLevel(price, currency, decimals, tariffUnit)),
        });
      }
      // Prices are in 1/100 pence, i.e. 4 decimal points of GBP (826)
      await priceServer.setFetchedSchedule({ currency: 826, decimalPoints: 4, entries });
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
