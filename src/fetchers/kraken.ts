import axios from 'axios';
import { getDatabase } from '../database/schema.js';
import { calculatePriceLevel, updatePriceLevelForForecast } from '../database/colors.js';
import { setCachedData, recordCacheMiss } from '../database/cache.js';

const KRAKEN_API_URL = 'https://api.kraken.energy/core/graphql';
const CACHE_TTL_MINUTES = 30;
const RETRY_CONFIG = {
  maxRetries: 3,
  backoffMs: 2000,
};

interface KrakenPrice {
  time: string;
  validFrom: string;
  validTo: string;
  priceInclusive: number;
}

interface KrakenRateData {
  businessDay: {
    rates: KrakenPrice[];
  };
}

export async function fetchKrakenPrices(
  apiKey: string,
  accountNumber?: string
): Promise<void> {
  const db = await getDatabase();

  // Check if source exists
  let sourceId = await db.get(
    "SELECT id FROM price_sources WHERE id = 'kraken'",
  );

  if (!sourceId) {
    const now = Math.floor(Date.now() / 1000);
    await db.run(
      `INSERT INTO price_sources (id, name, priority, enabled, api_key, created_at, updated_at)
       VALUES ('kraken', 'EDF Kraken', 1, 1, ?, ?, ?)`,
      [encryptApiKey(apiKey), now, now]
    );
  }

  let attempt = 0;
  while (attempt < RETRY_CONFIG.maxRetries) {
    try {
      const rateData = await queryKrakenGraphQL(apiKey);

      if (!rateData) {
        throw new Error('No rate data returned from Kraken API');
      }

      await storePriceForecast(rateData);
      return;
    } catch (error) {
      attempt++;
      if (attempt >= RETRY_CONFIG.maxRetries) {
        console.error('Kraken API failed after retries:', error);
        await recordCacheMiss(`kraken-prices`, 'kraken');
        throw error;
      }
      const delayMs = RETRY_CONFIG.backoffMs * Math.pow(2, attempt - 1);
      console.warn(`Kraken fetch attempt ${attempt} failed, retrying in ${delayMs}ms:`, error);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function queryKrakenGraphQL(apiKey: string): Promise<KrakenRateData | null> {
  const query = `
    query {
      businessDay {
        rates {
          time
          validFrom
          validTo
          priceInclusive
        }
      }
    }
  `;

  const response = await axios.post(
    KRAKEN_API_URL,
    { query },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );

  if (response.data.errors) {
    throw new Error(`Kraken GraphQL error: ${JSON.stringify(response.data.errors)}`);
  }

  return response.data.data;
}

async function storePriceForecast(rateData: KrakenRateData): Promise<void> {
  const db = await getDatabase();
  const now = Math.floor(Date.now() / 1000);

  // Delete old forecasts from this source to avoid duplicates
  await db.run('DELETE FROM commodity_price_forecasts WHERE source_id = ?', ['kraken']);

  if (!rateData.businessDay?.rates || rateData.businessDay.rates.length === 0) {
    throw new Error('No rates found in Kraken response');
  }

  // Kraken returns GBP prices in pence per kWh
  const currency = 'GBP';
  const decimals = 3; // pence = 0.01 GBP, so 1 pence = 0.001 in 3 decimal places
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
      ['kraken', currency, decimals, tariffUnit, periodMinutes, now, validUntil, now]
    )
  ).lastID as number;

  // Insert individual price points
  for (const rate of rateData.businessDay.rates) {
    const periodStart = Math.floor(new Date(rate.validFrom).getTime() / 1000);
    const periodEnd = Math.floor(new Date(rate.validTo).getTime() / 1000);

    // Kraken returns price in pence per kWh, multiply by 1 to keep in pence (0.001 GBP)
    const price = Math.round(rate.priceInclusive * 100); // Convert to smallest unit

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
    `kraken-prices`,
    'kraken',
    { forecastId, rate: rateData.businessDay.rates.length },
    CACHE_TTL_MINUTES
  );

  console.log(`Stored ${rateData.businessDay.rates.length} Kraken price points`);
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
