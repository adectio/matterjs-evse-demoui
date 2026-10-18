/**
 * Prices for the UI from whichever price source is selected (Octopus Agile, EDF FreePhase or the custom tariff),
 * in the same shape as the database queries return, so charts work the same for every source.
 */

import { getCustomTariff } from "../database/custom-tariff.js";
import { getCurrentPrice, getLatestPriceForecastMetadata, getPriceForecast } from "../database/queries.js";
import { getPriceSourceSettings, isPriceSourceId, PriceSourceId, priceSourceName } from "../database/settings.js";
import { CommodityPriceStruct, PriceLevel } from "../database/types.js";
import { TARIFF_SOURCES } from "../fetchers/tariff-sources.js";
import { expandDailyTariff } from "./schedule.js";

const PRICE_LEVEL_NAMES: PriceLevel[] = [PriceLevel.VERY_LOW, PriceLevel.LOW, PriceLevel.MEDIUM, PriceLevel.HIGH, PriceLevel.VERY_HIGH];
/** Prices from every source are in 1/100 of the minor unit, displayed in pence/cents */
const DISPLAY_DECIMALS = 2;

export type PriceSourceView = { id: PriceSourceId; name: string; detail: string | null };

/** The selected price source, or `requested` when it names a valid source */
export async function resolvePriceSource(requested?: string | null): Promise<PriceSourceView> {
    const settings = await getPriceSourceSettings();
    const id: PriceSourceId = isPriceSourceId(requested) ? requested : settings.active;
    if (id === "custom") {
        const tariff = await getCustomTariff();
        return { id, name: priceSourceName(id), detail: tariff?.name ?? null };
    }
    const { productCode, regionCode } = settings.tariffs[id];
    return { id, name: TARIFF_SOURCES[id].name, detail: `${productCode}, region ${regionCode}` };
}

async function customTariffPrices(fromSeconds: number): Promise<CommodityPriceStruct[]> {
    const tariff = await getCustomTariff();
    if (!tariff) return [];
    return expandDailyTariff(tariff, fromSeconds).entries.map(entry => ({
        periodStart: entry.periodStart,
        periodEnd: entry.periodEnd,
        price: entry.price,
        currency: tariff.currency,
        decimals: DISPLAY_DECIMALS,
        priceLevel: PRICE_LEVEL_NAMES[entry.priceLevel] ?? PriceLevel.MEDIUM,
    }));
}

export async function getActivePriceForecast(source: PriceSourceView, currency: string, hours: number, from?: number) {
    if (source.id !== "custom") return getPriceForecast(currency, hours, from, source.id);
    const now = Math.floor(Date.now() / 1000);
    return (await customTariffPrices(Math.min(from ?? now, now))).filter(entry => entry.periodStart <= now + hours * 3600);
}

export async function getActiveCurrentPrice(source: PriceSourceView, currency: string) {
    if (source.id !== "custom") return getCurrentPrice(currency, source.id);
    const now = Math.floor(Date.now() / 1000);
    return (await customTariffPrices(now)).find(entry => entry.periodStart <= now) ?? null;
}

export async function getActivePriceMetadata(source: PriceSourceView, currency: string) {
    if (source.id !== "custom") return getLatestPriceForecastMetadata(currency, source.id);
    const tariff = await getCustomTariff();
    return tariff
        ? { source_id: "custom", currency: tariff.currency, decimals: DISPLAY_DECIMALS, tariff_unit: "kWh", period_minutes: 30 }
        : null;
}
