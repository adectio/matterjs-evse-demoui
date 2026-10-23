import { getDatabase } from "../database/schema.js";
import { getGridConditionsForecast } from "../database/queries.js";
import { getCarbonHistory, getPriceHistory } from "../database/history.js";
import { CarbonPeriod, estimatePrices, PriceEstimate, PricePeriod } from "./estimator.js";

const PERIOD_SECONDS = 30 * 60;

export type PriceEstimateResult = PriceEstimate & {
    /** End of the last published (real) price, from which estimates start */
    publishedUntil: number | null;
};

/** Merge period series, keeping one value per period start (the later series wins) */
function mergeByPeriod<T extends { periodStart: number }>(...series: T[][]): T[] {
    const byStart = new Map<number, T>();
    for (const periods of series) {
        for (const period of periods) byStart.set(period.periodStart, period);
    }
    return [...byStart.values()].sort((a, b) => a.periodStart - b.periodStart);
}

/** Prices in the current forecast tables (covers the time before the history has been populated) */
async function getForecastPrices(currency: string, sourceId: string): Promise<PricePeriod[]> {
    const db = await getDatabase();
    const rows = (await db.all(
        `SELECT cp.period_start, cp.period_end, cp.price
         FROM commodity_prices cp
         JOIN commodity_price_forecasts cpf ON cp.forecast_id = cpf.id
         WHERE cpf.currency = ? AND cpf.source_id = ? AND cp.price IS NOT NULL`,
        [currency, sourceId],
    )) as Array<{ period_start: number; period_end: number | null; price: number }>;
    return rows.map(row => ({
        periodStart: row.period_start,
        periodEnd: row.period_end ?? row.period_start + PERIOD_SECONDS,
        price: row.price,
    }));
}

async function getForecastCarbon(region: string): Promise<CarbonPeriod[]> {
    return (await getGridConditionsForecast(region, 48))
        .filter(period => period.gridCarbonIntensity !== null && period.gridCarbonIntensity !== undefined)
        .map(period => ({
            periodStart: period.periodStart,
            periodEnd: period.periodEnd ?? period.periodStart + PERIOD_SECONDS,
            carbonIntensity: Number(period.gridCarbonIntensity),
        }));
}

/**
 * Estimate prices of a fetched tariff from the end of its published rates until `hours` from now, learning
 * from up to a month of its stored price history and the carbon history.
 */
export async function getEstimatedPrices(
    currency: string,
    region: string,
    hours: number,
    sourceId: string,
): Promise<PriceEstimateResult> {
    const now = Math.floor(Date.now() / 1000);

    const known = mergeByPeriod(await getForecastPrices(currency, sourceId), await getPriceHistory(currency, sourceId));
    const carbon = mergeByPeriod<CarbonPeriod>(await getCarbonHistory(region), await getForecastCarbon(region));

    const publishedUntil = known.length > 0 ? Math.max(...known.map(period => period.periodEnd)) : null;
    const currentPeriodStart = now - (now % PERIOD_SECONDS);
    const from = Math.max(publishedUntil ?? currentPeriodStart, currentPeriodStart);
    return { ...estimatePrices(known, carbon, from, now + hours * 3600), publishedUntil };
}
