/**
 * Dynamic tariffs fetched from Kraken-platform suppliers. Octopus and EDF both publish half-hourly unit rates
 * on the same public (keyless) REST API, differing only in the API host and product codes.
 */

export type TariffSourceId = 'octopus' | 'edf';

export interface TariffSource {
  id: TariffSourceId;
  name: string;
  /** REST API root, without a trailing slash */
  apiBase: string;
  defaultProductCode: string;
  defaultRegionCode: string;
}

export const TARIFF_SOURCES: Record<TariffSourceId, TariffSource> = {
  octopus: {
    id: 'octopus',
    name: 'Octopus Agile',
    apiBase: 'https://api.octopus.energy/v1',
    defaultProductCode: process.env.OCTOPUS_PRODUCT_CODE || 'AGILE-24-10-01',
    defaultRegionCode: process.env.OCTOPUS_REGION || 'E',
  },
  edf: {
    id: 'edf',
    name: 'EDF FreePhase Dynamic',
    apiBase: 'https://api.edfgb-kraken.energy/v1',
    defaultProductCode: process.env.EDF_PRODUCT_CODE || 'EDF_FREEPHASE_DYNAMIC_12M_V2_HH',
    defaultRegionCode: process.env.EDF_REGION || process.env.OCTOPUS_REGION || 'E',
  },
};

export const TARIFF_SOURCE_IDS = Object.keys(TARIFF_SOURCES) as TariffSourceId[];

export function isTariffSourceId(value: unknown): value is TariffSourceId {
  return typeof value === 'string' && value in TARIFF_SOURCES;
}
