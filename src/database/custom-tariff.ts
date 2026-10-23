import { getDatabase } from './schema.js';

/**
 * A daily-repeating time-of-use tariff.
 *
 * Prices use the same unit as the fetchers: 1/100 of the currency's minor unit (e.g. 2500 = 25p/kWh), which is
 * 4 decimal points of the major unit.
 */
export interface CustomTariff {
  name: string;
  currency: 'GBP' | 'EUR';
  periods: CustomTariffPeriod[];
}

export interface CustomTariffPeriod {
  /** Local minutes past midnight; the period runs until the next period's start (wrapping past midnight) */
  startMinutes: number;
  price: number;
  /** 0 (very low) to 4 (very high); null derives it from the tariff's price range */
  priceLevel: number | null;
  description?: string;
}

export const CUSTOM_TARIFF_DECIMALS = 4;
export const CURRENCY_CODES = { GBP: 826, EUR: 978 } as const;

export async function getCustomTariff(): Promise<CustomTariff | null> {
  const db = await getDatabase();
  const tariff = await db.get('SELECT id, name, currency FROM custom_tariffs ORDER BY id DESC LIMIT 1');
  if (!tariff) return null;

  const periods = await db.all(
    `SELECT period_start_minutes, price, price_level, description
     FROM custom_tariff_periods WHERE tariff_id = ? ORDER BY period_start_minutes`,
    [tariff.id]
  );
  return {
    name: tariff.name,
    currency: tariff.currency,
    periods: periods.map((p: any) => ({
      startMinutes: p.period_start_minutes,
      price: p.price,
      priceLevel: p.price_level,
      description: p.description ?? undefined,
    })),
  };
}

/** Replace the custom tariff (only one is kept) */
export async function saveCustomTariff(input: unknown): Promise<CustomTariff> {
  const tariff = validateCustomTariff(input);
  const db = await getDatabase();
  const now = Math.floor(Date.now() / 1000);

  await db.exec('BEGIN');
  try {
    await db.run('DELETE FROM custom_tariffs');
    const tariffId = (
      await db.run(
        `INSERT INTO custom_tariffs (name, currency, decimals, tariff_unit, period_minutes, created_at, updated_at)
         VALUES (?, ?, ?, 'kWh', 30, ?, ?)`,
        [tariff.name, tariff.currency, CUSTOM_TARIFF_DECIMALS, now, now]
      )
    ).lastID;
    for (const [index, period] of tariff.periods.entries()) {
      const next = tariff.periods[(index + 1) % tariff.periods.length];
      await db.run(
        `INSERT INTO custom_tariff_periods
         (tariff_id, period_start_minutes, period_end_minutes, price, price_level, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [tariffId, period.startMinutes, next.startMinutes, period.price, period.priceLevel, period.description ?? null, now]
      );
    }
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
  return tariff;
}

export async function clearCustomTariff(): Promise<void> {
  const db = await getDatabase();
  await db.run('DELETE FROM custom_tariffs');
}

function validateCustomTariff(input: unknown): CustomTariff {
  const body = (input ?? {}) as Record<string, unknown>;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new Error('Enter a tariff name.');
  if (body.currency !== 'GBP' && body.currency !== 'EUR') throw new Error('Currency must be GBP or EUR.');
  if (!Array.isArray(body.periods) || body.periods.length === 0) throw new Error('Add at least one price period.');

  const periods = body.periods.map((value: any, index: number): CustomTariffPeriod => {
    const row = `Period ${index + 1}`;
    if (!Number.isInteger(value?.startMinutes) || value.startMinutes < 0 || value.startMinutes >= 24 * 60) {
      throw new Error(`${row}: start time is invalid.`);
    }
    if (!Number.isSafeInteger(value.price)) {
      throw new Error(`${row}: price is invalid.`);
    }
    const priceLevel = value.priceLevel ?? null;
    if (priceLevel !== null && !(Number.isInteger(priceLevel) && priceLevel >= 0 && priceLevel <= 4)) {
      throw new Error(`${row}: price level must be 0–4.`);
    }
    const description = typeof value.description === 'string' && value.description.trim() ? value.description.trim() : undefined;
    return { startMinutes: value.startMinutes, price: value.price, priceLevel, description };
  });
  periods.sort((a, b) => a.startMinutes - b.startMinutes);
  for (let i = 1; i < periods.length; i++) {
    if (periods[i].startMinutes === periods[i - 1].startMinutes) {
      throw new Error('Two periods start at the same time.');
    }
  }
  return { name, currency: body.currency, periods };
}
