import { getDatabase } from './schema.js';

/** How long price and carbon history is kept */
export const HISTORY_DAYS = 31;
/** Below this much history, the fetchers backfill from the source APIs */
export const BACKFILL_THRESHOLD_DAYS = 28;

const DAY_SECONDS = 24 * 3600;

export type PriceHistoryRow = { periodStart: number; periodEnd: number; price: number };
export type CarbonHistoryRow = { periodStart: number; periodEnd: number; carbonIntensity: number; isActual: boolean };

/** Rows per multi-row INSERT; each statement is atomic without needing a shared-connection transaction */
const INSERT_BATCH = 100;

async function insertBatched<T>(rows: T[], valuesClause: string, sqlFor: (values: string) => string, params: (row: T) => unknown[]) {
  const db = await getDatabase();
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH);
    await db.run(sqlFor(batch.map(() => valuesClause).join(', ')), batch.flatMap(params));
  }
}

export async function recordPriceHistory(
  sourceId: string,
  currency: string,
  decimals: number,
  rows: PriceHistoryRow[]
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await insertBatched(
    rows,
    '(?, ?, ?, ?, ?, ?, ?)',
    (values) => `INSERT INTO commodity_price_history
         (source_id, currency, decimals, period_start, period_end, price, recorded_at)
       VALUES ${values}
       ON CONFLICT (source_id, period_start) DO UPDATE SET
         currency = excluded.currency, decimals = excluded.decimals, period_end = excluded.period_end,
         price = excluded.price, recorded_at = excluded.recorded_at`,
    (row) => [sourceId, currency, decimals, row.periodStart, row.periodEnd, row.price, now]
  );
  await pruneHistory();
}

export async function recordCarbonHistory(sourceId: string, region: string, rows: CarbonHistoryRow[]): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // A measured (actual) value is never overwritten by a later forecast
  await insertBatched(
    rows,
    '(?, ?, ?, ?, ?, ?, ?)',
    (values) => `INSERT INTO grid_carbon_history
         (source_id, region, period_start, period_end, carbon_intensity, is_actual, recorded_at)
       VALUES ${values}
       ON CONFLICT (source_id, region, period_start) DO UPDATE SET
         period_end = excluded.period_end, carbon_intensity = excluded.carbon_intensity,
         is_actual = excluded.is_actual, recorded_at = excluded.recorded_at
       WHERE excluded.is_actual = 1 OR grid_carbon_history.is_actual = 0`,
    (row) => [sourceId, region, row.periodStart, row.periodEnd, row.carbonIntensity, row.isActual ? 1 : 0, now]
  );
  await pruneHistory();
}

export async function pruneHistory(): Promise<void> {
  const db = await getDatabase();
  const cutoff = Math.floor(Date.now() / 1000) - HISTORY_DAYS * DAY_SECONDS;
  await db.run('DELETE FROM commodity_price_history WHERE period_start < ?', [cutoff]);
  await db.run('DELETE FROM grid_carbon_history WHERE period_start < ?', [cutoff]);
}

/** Days of past history held (from the oldest stored period up to now) */
export async function priceHistoryDays(sourceId: string): Promise<number> {
  const db = await getDatabase();
  const row = await db.get('SELECT MIN(period_start) AS oldest FROM commodity_price_history WHERE source_id = ?', [sourceId]);
  return row?.oldest ? (Date.now() / 1000 - row.oldest) / DAY_SECONDS : 0;
}

export async function carbonHistoryDays(sourceId: string, region: string): Promise<number> {
  const db = await getDatabase();
  const row = await db.get(
    'SELECT MIN(period_start) AS oldest FROM grid_carbon_history WHERE source_id = ? AND region = ?',
    [sourceId, region]
  );
  return row?.oldest ? (Date.now() / 1000 - row.oldest) / DAY_SECONDS : 0;
}

export async function getPriceHistory(currency: string, sourceId?: string): Promise<PriceHistoryRow[]> {
  const db = await getDatabase();
  const rows = (await db.all(
    `SELECT period_start, period_end, price FROM commodity_price_history
     WHERE currency = ? AND (? IS NULL OR source_id = ?) ORDER BY period_start ASC`,
    [currency, sourceId ?? null, sourceId ?? null]
  )) as Array<{ period_start: number; period_end: number; price: number }>;
  return rows.map((row) => ({ periodStart: row.period_start, periodEnd: row.period_end, price: row.price }));
}

export async function getCarbonHistory(region: string): Promise<CarbonHistoryRow[]> {
  const db = await getDatabase();
  const rows = (await db.all(
    `SELECT period_start, period_end, carbon_intensity, is_actual FROM grid_carbon_history
     WHERE region = ? ORDER BY period_start ASC`,
    [region]
  )) as Array<{ period_start: number; period_end: number; carbon_intensity: number; is_actual: number }>;
  return rows.map((row) => ({
    periodStart: row.period_start,
    periodEnd: row.period_end,
    carbonIntensity: row.carbon_intensity,
    isActual: row.is_actual === 1,
  }));
}
