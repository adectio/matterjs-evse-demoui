import axios from 'axios';
import { getDatabase } from '../database/schema.js';
import { calculateCarbonLevel, updateCarbonLevelForForecast } from '../database/colors.js';
import { setCachedData, recordCacheMiss } from '../database/cache.js';
import { BACKFILL_THRESHOLD_DAYS, HISTORY_DAYS, carbonHistoryDays, recordCarbonHistory } from '../database/history.js';

const CARBON_API_URL = 'https://api.carbonintensity.org.uk';
const CACHE_TTL_MINUTES = 30;
const RETRY_CONFIG = {
  maxRetries: 2, // Reduced retries for non-critical data source
  backoffMs: 3000, // Longer backoff
};

interface CarbonData {
  from: string;
  to: string;
  intensity: {
    actual: number | null;
    forecast: number;
    index: string;
  };
}

/** The national range endpoint returns at most 14 days per request */
const BACKFILL_WINDOW_DAYS = 14;
const HISTORY_SOURCE = 'uk-carbon-intensity';
const HISTORY_REGION = 'uk';

interface CarbonIntensityResponse {
  data: CarbonData[];
}

export async function fetchUKCarbonIntensity(postcode?: string): Promise<void> {
  const db = await getDatabase();

  // Check if source exists
  let sourceId = await db.get(
    "SELECT id FROM grid_sources WHERE id = 'uk-carbon-intensity'",
  );

  if (!sourceId) {
    const now = Math.floor(Date.now() / 1000);
    await db.run(
      `INSERT INTO grid_sources (id, name, region, priority, enabled, metadata, created_at, updated_at)
       VALUES ('uk-carbon-intensity', 'UK Carbon Intensity', 'uk', 1, 1, ?, ?, ?)`,
      [JSON.stringify({ postcode }), now, now]
    );
  }

  let attempt = 0;
  while (attempt < RETRY_CONFIG.maxRetries) {
    try {
      const data = await queryUKCarbonIntensityAPI(postcode);

      if (!data) {
        throw new Error('No data returned from Carbon Intensity API');
      }

      await recordCarbonHistory(HISTORY_SOURCE, HISTORY_REGION, data.map(toCarbonHistoryRow));
      await storeGridConditionsForecast(data, 'uk', postcode);
      // Past measured values (national only) give the price estimator a month to learn from
      if (!postcode) {
        await backfillCarbonHistory().catch((error) => console.warn('Carbon history backfill failed:', error));
      }
      return;
    } catch (error) {
      attempt++;
      if (attempt >= RETRY_CONFIG.maxRetries) {
        console.error('Carbon Intensity API failed after retries:', error);
        await recordCacheMiss(`uk-carbon-intensity`, 'uk-carbon-intensity');
        throw error;
      }
      const delayMs = RETRY_CONFIG.backoffMs * Math.pow(2, attempt - 1);
      console.warn(
        `Carbon Intensity fetch attempt ${attempt} failed, retrying in ${delayMs}ms:`,
        error
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function toCarbonHistoryRow(point: CarbonData) {
  const actual = point.intensity.actual;
  return {
    periodStart: Math.floor(new Date(point.from).getTime() / 1000),
    periodEnd: Math.floor(new Date(point.to).getTime() / 1000),
    carbonIntensity: Math.round(actual ?? point.intensity.forecast),
    isActual: actual !== null && actual !== undefined,
  };
}

async function backfillCarbonHistory(): Promise<void> {
  if ((await carbonHistoryDays(HISTORY_SOURCE, HISTORY_REGION)) >= BACKFILL_THRESHOLD_DAYS) {
    return;
  }
  const end = Date.now();
  let recorded = 0;
  for (let from = end - HISTORY_DAYS * 24 * 3600 * 1000; from < end; from += BACKFILL_WINDOW_DAYS * 24 * 3600 * 1000) {
    const to = Math.min(from + BACKFILL_WINDOW_DAYS * 24 * 3600 * 1000, end);
    const url = `${CARBON_API_URL}/intensity/${new Date(from).toISOString()}/${new Date(to).toISOString()}`;
    const response = await axios.get(url, { timeout: 30000 });
    const points: CarbonData[] = Array.isArray(response.data?.data) ? response.data.data : [];
    await recordCarbonHistory(HISTORY_SOURCE, HISTORY_REGION, points.map(toCarbonHistoryRow));
    recorded += points.length;
  }
  console.log(`Backfilled carbon intensity history with ${recorded} periods`);
}

async function queryUKCarbonIntensityAPI(postcode?: string): Promise<CarbonData[] | null> {
  // Request 24-hour forecast with current timestamp
  const now = new Date().toISOString(); // e.g., 2026-10-11T10:30:00Z
  let url = `${CARBON_API_URL}/intensity/${now}/fw24h`;

  if (postcode) {
    url = `${CARBON_API_URL}/intensity/postcode/${encodeURIComponent(postcode)}/${now}/fw24h`;
  }

  console.log('Fetching from URL:', url);

  const response = await axios.get(url, {
    timeout: 30000, // Increased to 30 seconds for slow networks
  });

  console.log('Carbon Intensity API response status:', response.status);
  console.log('Carbon Intensity API response keys:', response.data ? Object.keys(response.data) : 'null/undefined');
  console.log('Carbon Intensity full response:', JSON.stringify(response.data).substring(0, 300));

  // Handle different response formats
  let data = response.data?.data;

  if (!data) {
    // Try alternative format (API might return data directly)
    if (Array.isArray(response.data)) {
      data = response.data;
    } else if (response.data && typeof response.data === 'object') {
      console.warn('Unexpected Carbon Intensity API response format:', Object.keys(response.data));
      throw new Error(`Invalid Carbon Intensity API response format: ${JSON.stringify(response.data).substring(0, 200)}`);
    }
  }
  console.log('Carbon Intensity parsed data:', data ? 'found' : 'not found');
  if (!data || !Array.isArray(data)) {
    throw new Error('Invalid Carbon Intensity API response format');
  }

  return data;
}

async function storeGridConditionsForecast(
  data: CarbonData[],
  region: string,
  postcode?: string
): Promise<void> {
  const db = await getDatabase();
  const now = Math.floor(Date.now() / 1000);

  // Delete old forecasts from this source to avoid duplicates
  await db.run('DELETE FROM grid_conditions_forecasts WHERE source_id = ?', ['uk-carbon-intensity']);

  console.log(`Carbon Intensity raw data sample:`, JSON.stringify(data.slice(0, 2)));

  if (data.length === 0) {
    throw new Error('No carbon data found in API response');
  }

  // Calculate valid_until: data is valid for at least 1 hour from fetch time
  const validUntil = now + (60 * 60); // Valid for 1 hour

  // Insert forecast record
  const forecastId = (
    await db.run(
      `INSERT INTO grid_conditions_forecasts
       (source_id, region, postcode, fetched_at, valid_until, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['uk-carbon-intensity', region, postcode || null, now, validUntil, now]
    )
  ).lastID as number;

  // Insert individual data points
  for (const point of data) {
    const periodStart = Math.floor(new Date(point.from).getTime() / 1000);
    const periodEnd = Math.floor(new Date(point.to).getTime() / 1000);

    // Store forecast carbon intensity (gCO2/kWh) - use forecast value for future planning
    const gridCarbonIntensity = Math.round(point.intensity.forecast);

    // Calculate carbon level based on forecast
    const gridCarbonLevel = await calculateCarbonLevel(gridCarbonIntensity, region);

    await db.run(
      `INSERT INTO grid_conditions
       (forecast_id, period_start, period_end, grid_carbon_intensity, grid_carbon_level, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [forecastId, periodStart, periodEnd, gridCarbonIntensity, gridCarbonLevel, now]
    );
  }

  // Update color levels for all conditions in this forecast (if region is defined)
  if (region) {
    await updateCarbonLevelForForecast(forecastId, region);
  }

  // Cache metadata
  await setCachedData(
    `uk-carbon-intensity`,
    'uk-carbon-intensity',
    {
      forecastId,
      dataPoints: data.length,
      postcode: postcode || 'national',
    },
    CACHE_TTL_MINUTES
  );

  console.log(
    `Stored ${data.length} UK carbon intensity data points for ${postcode || 'national'}`
  );

  // Update price server if available
  try {
    const priceServer = (globalThis as any).__priceServer;
    if (priceServer) {
      // Find current carbon intensity
      const now = Math.floor(Date.now() / 1000);
      const currentData = data.find(point => {
        const start = Math.floor(new Date(point.from).getTime() / 1000);
        const end = Math.floor(new Date(point.to).getTime() / 1000);
        return start <= now && now < end;
      });

      if (currentData) {
        const carbonIntensity = Math.round(currentData.intensity.forecast);
        await priceServer.setGridConditions(carbonIntensity);
      }

      // Build forecast for next 24 hours
      const forecast = data.map(point => ({
        periodStart: Math.floor(new Date(point.from).getTime() / 1000),
        periodEnd: Math.floor(new Date(point.to).getTime() / 1000),
        carbonIntensity: Math.round(point.intensity.forecast),
      }));

      if (forecast.length > 0) {
        await priceServer.setGridForecast(forecast);
      }
    }
  } catch (e) {
    console.warn('Error updating price server from carbon intensity data:', e);
  }
}

// EU Carbon Data fetcher (placeholder for multiple regions)
export async function fetchEUCarbonIntensity(
  region: string,
  countryCode?: string
): Promise<void> {
  // This is a placeholder - EU carbon data sources vary by country
  // For now, using a generic approach that could be extended
  // Example: Germany (Stromdaten.info), France (RTE), etc.

  console.warn(
    `EU Carbon Intensity fetcher for region "${region}" not yet fully implemented. ` +
    `Please configure the appropriate regional data source.`
  );
}
