import { getDatabase } from './schema.js';
import { isTariffSourceId, TARIFF_SOURCES, TARIFF_SOURCE_IDS, TariffSourceId } from '../fetchers/tariff-sources.js';

/** Which prices the price server publishes: a fetched dynamic tariff or the custom time-of-use tariff */
export type PriceSourceId = TariffSourceId | 'custom';

export interface TariffSourceConfig {
  productCode: string;
  regionCode: string;
}

export interface PriceSourceSettings {
  active: PriceSourceId;
  /** The fetched tariff that was selected before the custom tariff (to return to when it is cleared) */
  previousTariff?: TariffSourceId;
  /** Product and region for each fetched tariff (all are fetched, whichever is active) */
  tariffs: Record<TariffSourceId, TariffSourceConfig>;
}

const PRICE_SOURCE_KEY = 'price_source';
const REGION_CODES = 'ABCDEFGHJKLMNP';

function defaults(): PriceSourceSettings {
  return {
    active: 'octopus',
    tariffs: Object.fromEntries(
      TARIFF_SOURCE_IDS.map((id) => [
        id,
        { productCode: TARIFF_SOURCES[id].defaultProductCode, regionCode: TARIFF_SOURCES[id].defaultRegionCode },
      ])
    ) as Record<TariffSourceId, TariffSourceConfig>,
  };
}

export async function getPriceSourceSettings(): Promise<PriceSourceSettings> {
  const settings = defaults();
  const db = await getDatabase();
  const row = await db.get('SELECT value FROM app_settings WHERE key = ?', [PRICE_SOURCE_KEY]);
  if (!row) return settings;
  try {
    const stored = JSON.parse(row.value);
    if (isPriceSourceId(stored.active)) settings.active = stored.active;
    if (isTariffSourceId(stored.previousTariff)) settings.previousTariff = stored.previousTariff;
    for (const id of TARIFF_SOURCE_IDS) {
      settings.tariffs[id] = { ...settings.tariffs[id], ...(stored.tariffs?.[id] ?? {}) };
    }
  } catch {
    console.warn('Ignoring invalid stored price source settings');
  }
  return settings;
}

/** Validate and merge changes into the stored settings */
export async function savePriceSourceSettings(changes: unknown): Promise<PriceSourceSettings> {
  const body = (changes ?? {}) as { active?: unknown; tariffs?: Record<string, Partial<TariffSourceConfig>> };
  const settings = await getPriceSourceSettings();

  if (body.active !== undefined) {
    if (!isPriceSourceId(body.active)) throw new Error('Unknown price source.');
    if (body.active === 'custom' && settings.active !== 'custom') settings.previousTariff = settings.active;
    settings.active = body.active;
  }
  for (const [id, tariff] of Object.entries(body.tariffs ?? {})) {
    if (!isTariffSourceId(id)) throw new Error(`Unknown tariff "${id}".`);
    if (tariff.productCode !== undefined) {
      if (typeof tariff.productCode !== 'string' || !/^[A-Z0-9_-]{3,64}$/i.test(tariff.productCode.trim())) {
        throw new Error(`${TARIFF_SOURCES[id].name}: the product code is invalid.`);
      }
      settings.tariffs[id].productCode = tariff.productCode.trim();
    }
    if (tariff.regionCode !== undefined) {
      if (typeof tariff.regionCode !== 'string' || tariff.regionCode.length !== 1 || !REGION_CODES.includes(tariff.regionCode)) {
        throw new Error(`${TARIFF_SOURCES[id].name}: the region must be one of ${REGION_CODES.split('').join(', ')}.`);
      }
      settings.tariffs[id].regionCode = tariff.regionCode;
    }
  }

  const db = await getDatabase();
  await db.run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [PRICE_SOURCE_KEY, JSON.stringify(settings), Math.floor(Date.now() / 1000)]
  );
  return settings;
}

export function isPriceSourceId(value: unknown): value is PriceSourceId {
  return value === 'custom' || isTariffSourceId(value);
}

export function priceSourceName(id: PriceSourceId): string {
  return id === 'custom' ? 'Custom tariff' : TARIFF_SOURCES[id].name;
}
