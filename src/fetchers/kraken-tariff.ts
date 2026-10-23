import axios from 'axios';
import { getDatabase } from '../database/schema.js';
import { calculatePriceLevel, updatePriceLevelForForecast } from '../database/colors.js';
import { setCachedData, recordCacheMiss } from '../database/cache.js';
import { BACKFILL_THRESHOLD_DAYS, HISTORY_DAYS, priceHistoryDays, recordPriceHistory } from '../database/history.js';
import { getPriceSourceSettings } from '../database/settings.js';
import { priceLevelNumber } from '../price-server/schedule.js';
import { TARIFF_SOURCES, TariffSource, TariffSourceId } from './tariff-sources.js';

const CACHE_TTL_MINUTES = 60; // Cache for 1 hour - rates are published daily
/** Older rates are only kept in the history table, not in the current forecast */
const FORECAST_LOOKBACK_SECONDS = 2 * 24 * 3600;
/** Follow at most this many pages of results (1500 rates each) */
const MAX_PAGES = 3;
const RETRY_CONFIG = {
  maxRetries: 3,
  backoffMs: 2000,
};

// Prices are stored in 1/100 pence (value_inc_vat is in pence per kWh)
const CURRENCY = 'GBP';
const DECIMALS = 2;
const TARIFF_UNIT = 'kWh';
const PERIOD_MINUTES = 30;

interface KrakenRate {
  valid_from: string;
  valid_to: string;
  value_inc_vat: number;
  value_exc_vat: number;
}

/**
 * Fetch the half-hourly unit rates of a Kraken-platform dynamic tariff (Octopus Agile, EDF FreePhase, ...) using
 * the product and region from the price source settings.
 */
export async function fetchKrakenTariffRates(sourceId: TariffSourceId): Promise<void> {
  const source = TARIFF_SOURCES[sourceId];
  const { productCode, regionCode } = (await getPriceSourceSettings()).tariffs[sourceId];
  await registerSource(source, productCode, regionCode);

  let attempt = 0;
  while (attempt < RETRY_CONFIG.maxRetries) {
    try {
      // Fill the history with a month of past rates when it is short (e.g. first run)
      const backfill = (await priceHistoryDays(source.id)) < BACKFILL_THRESHOLD_DAYS;
      const periodFrom = backfill ? new Date(Date.now() - HISTORY_DAYS * 24 * 3600 * 1000).toISOString() : undefined;
      const rates = await queryRates(source, productCode, regionCode, periodFrom);
      if (rates.length === 0) {
        throw new Error(`No rates returned for ${productCode} region ${regionCode}`);
      }

      const halfHourly = rates.filter(isHalfHourlyRate);
      await recordPriceHistory(
        source.id,
        CURRENCY,
        DECIMALS,
        halfHourly.map((rate) => ({
          periodStart: toSeconds(rate.valid_from),
          periodEnd: toSeconds(rate.valid_to),
          price: toPrice(rate),
        }))
      );
      if (backfill) {
        console.log(`Backfilled ${source.name} price history with ${halfHourly.length} rates`);
      }

      const recentCutoff = Date.now() - FORECAST_LOOKBACK_SECONDS * 1000;
      await storePriceForecast(
        source,
        productCode,
        regionCode,
        halfHourly.filter((rate) => new Date(rate.valid_to).getTime() > recentCutoff)
      );
      return;
    } catch (error) {
      attempt++;
      if (attempt >= RETRY_CONFIG.maxRetries) {
        console.error(`${source.name} fetch failed after retries:`, error);
        await recordCacheMiss(`${source.id}-rates-${regionCode}`, source.id);
        throw error;
      }
      const delayMs = RETRY_CONFIG.backoffMs * Math.pow(2, attempt - 1);
      console.warn(`${source.name} fetch attempt ${attempt} failed, retrying in ${delayMs}ms:`, error);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function registerSource(source: TariffSource, productCode: string, regionCode: string) {
  const db = await getDatabase();
  const now = Math.floor(Date.now() / 1000);
  await db.run(
    `INSERT INTO price_sources (id, name, priority, enabled, api_key, metadata, created_at, updated_at)
     VALUES (?, ?, 1, 1, NULL, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, metadata = excluded.metadata, updated_at = excluded.updated_at`,
    [source.id, source.name, JSON.stringify({ productCode, regionCode }), now, now]
  );
}

async function queryRates(
  source: TariffSource,
  productCode: string,
  regionCode: string,
  periodFrom?: string
): Promise<KrakenRate[]> {
  const tariffCode = `E-1R-${productCode}-${regionCode}`;
  let url: string | null = `${source.apiBase}/products/${productCode}/electricity-tariffs/${tariffCode}/standard-unit-rates/`;
  const params: Record<string, string | number> | undefined = periodFrom
    ? { period_from: periodFrom, page_size: 1500 }
    : undefined;

  // A backfill can span more than one page
  const results: KrakenRate[] = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const response: { data: { results?: KrakenRate[]; next?: string | null } } = await axios.get(url, {
      timeout: 30000,
      params: page === 0 ? params : undefined,
    });
    if (!response.data?.results) {
      throw new Error(`Invalid ${source.name} API response format`);
    }
    results.push(...response.data.results);
    url = periodFrom ? response.data.next ?? null : null;
  }
  return results;
}

function isHalfHourlyRate(rate: KrakenRate) {
  return new Date(rate.valid_to).getTime() - new Date(rate.valid_from).getTime() === 30 * 60 * 1000;
}

function toSeconds(iso: string) {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/** 1/100 pence per kWh, including VAT */
function toPrice(rate: KrakenRate) {
  return Math.round(rate.value_inc_vat * 100);
}

async function storePriceForecast(
  source: TariffSource,
  productCode: string,
  regionCode: string,
  rates: KrakenRate[]
): Promise<void> {
  const db = await getDatabase();
  const now = Math.floor(Date.now() / 1000);

  // Replace this source's previous forecast
  await db.run('DELETE FROM commodity_price_forecasts WHERE source_id = ?', [source.id]);

  // Rates are published at least a day ahead
  const validUntil = now + 24 * 3600;
  const forecastId = (
    await db.run(
      `INSERT INTO commodity_price_forecasts
       (source_id, currency, decimals, tariff_unit, period_minutes, fetched_at, valid_until, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [source.id, CURRENCY, DECIMALS, TARIFF_UNIT, PERIOD_MINUTES, now, validUntil, now]
    )
  ).lastID as number;

  const entries = [];
  for (const rate of rates) {
    const periodStart = toSeconds(rate.valid_from);
    const periodEnd = toSeconds(rate.valid_to);
    const price = toPrice(rate);
    const priceLevel = await calculatePriceLevel(price, CURRENCY, DECIMALS, TARIFF_UNIT);
    await db.run(
      `INSERT INTO commodity_prices
       (forecast_id, period_start, period_end, price, price_level, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [forecastId, periodStart, periodEnd, price, priceLevel, now]
    );
    entries.push({ periodStart, periodEnd, price, priceLevel: priceLevelNumber(priceLevel) });
  }

  // Update color levels for all prices in this forecast
  await updatePriceLevelForForecast(forecastId);

  await setCachedData(
    `${source.id}-rates-${regionCode}`,
    source.id,
    { forecastId, rateCount: rates.length, productCode, regionCode },
    CACHE_TTL_MINUTES
  );
  console.log(`Stored ${rates.length} ${source.name} rate points (${productCode}, region ${regionCode})`);

  // Every fetched tariff is offered to the price server; it publishes whichever is selected
  try {
    const priceServer = (globalThis as any).__priceServer;
    // Prices are in 1/100 pence, i.e. 4 decimal points of GBP (826)
    await priceServer?.setFetchedSchedule(source.id, { currency: 826, decimalPoints: 4, entries });
  } catch (e) {
    console.warn(`Error updating price server from ${source.name} data:`, e);
  }
}
