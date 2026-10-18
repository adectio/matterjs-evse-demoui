/**
 * Price estimation for periods whose tariff hasn't been published yet (e.g. Octopus Agile
 * publishes the next day's prices in the afternoon).
 *
 * Model:
 *   estimate(t) = profile(time of day of t) + k × (carbon(t) − mean carbon)
 *
 * - profile: average known price for each local half-hour of the day
 * - k: least squares slope of (price − profile) against grid carbon intensity, over periods where
 *   both a published price and a carbon forecast exist. With too few paired periods, or a fitted
 *   slope ≤ 0 (a greener grid shouldn't make power look more expensive), a prior elasticity is used
 *   instead: a carbon intensity 10% above average makes the price 5% above typical.
 */

export type PricePeriod = { periodStart: number; periodEnd: number; price: number };
export type CarbonPeriod = { periodStart: number; periodEnd: number; carbonIntensity: number };

export type PriceEstimateModel = {
    /** Half-hours of the day with a typical price (of 48) */
    profileCoverage: number;
    /** Price units per gCO2/kWh above the mean (0 when carbon isn't used) */
    carbonSlope: number;
    /** Whether carbonSlope was fitted from paired price/carbon data or is the prior */
    carbonSlopeSource: "fitted" | "prior" | "none";
    /** Periods with both a published price and a carbon forecast used to fit carbonSlope */
    carbonPairs: number;
    meanCarbon: number | null;
};

export type PriceEstimate = { estimates: PricePeriod[]; model: PriceEstimateModel };

const PERIOD_SECONDS = 30 * 60;
const MIN_CARBON_PAIRS = 6;
/** Prior relative price change per relative carbon change, when the data can't support a fit */
const PRIOR_CARBON_ELASTICITY = 0.5;

/** Local half-hour of the day (0-47); tariffs follow local wall clock time */
function halfHourOfDay(epochSeconds: number) {
    const date = new Date(epochSeconds * 1000);
    return date.getHours() * 2 + (date.getMinutes() >= 30 ? 1 : 0);
}

function mean(values: number[]) {
    return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Estimate prices for each half-hour from `from` (normally the end of the last published price)
 * until `until`.
 */
export function estimatePrices(
    knownPrices: PricePeriod[],
    carbon: CarbonPeriod[],
    from: number,
    until: number,
): PriceEstimate {
    const model: PriceEstimateModel = {
        profileCoverage: 0,
        carbonSlope: 0,
        carbonSlopeSource: "none",
        carbonPairs: 0,
        meanCarbon: null,
    };
    if (knownPrices.length === 0 || until <= from) {
        return { estimates: [], model };
    }

    const bySlot = new Map<number, number[]>();
    for (const period of knownPrices) {
        const slot = halfHourOfDay(period.periodStart);
        bySlot.set(slot, [...(bySlot.get(slot) ?? []), period.price]);
    }
    const overallMean = mean(knownPrices.map(period => period.price));
    const profile = (epochSeconds: number) => {
        const prices = bySlot.get(halfHourOfDay(epochSeconds));
        return prices === undefined ? overallMean : mean(prices);
    };
    model.profileCoverage = bySlot.size;

    // Half-hour periods are looked up by start time; anything else falls back to a scan
    const carbonByStart = new Map(carbon.map(period => [period.periodStart, period.carbonIntensity]));
    const carbonAt = (epochSeconds: number) =>
        carbonByStart.get(epochSeconds) ??
        carbon.find(period => period.periodStart <= epochSeconds && epochSeconds < period.periodEnd)?.carbonIntensity;

    // Fit how far prices sit above/below their typical value as carbon intensity changes
    const pairs = knownPrices
        .map(period => ({ carbon: carbonAt(period.periodStart), residual: period.price - profile(period.periodStart) }))
        .filter((pair): pair is { carbon: number; residual: number } => pair.carbon !== undefined);
    model.carbonPairs = pairs.length;
    if (pairs.length >= MIN_CARBON_PAIRS) {
        const meanCarbon = mean(pairs.map(pair => pair.carbon));
        const meanResidual = mean(pairs.map(pair => pair.residual));
        let covariance = 0;
        let variance = 0;
        for (const pair of pairs) {
            covariance += (pair.carbon - meanCarbon) * (pair.residual - meanResidual);
            variance += (pair.carbon - meanCarbon) ** 2;
        }
        model.meanCarbon = meanCarbon;
        if (variance > 0 && covariance > 0) {
            model.carbonSlope = covariance / variance;
            model.carbonSlopeSource = "fitted";
        }
    }
    if (model.carbonSlopeSource === "none" && carbon.length > 0) {
        model.meanCarbon ??= mean(carbon.map(period => period.carbonIntensity));
        if (model.meanCarbon > 0) {
            model.carbonSlope = (PRIOR_CARBON_ELASTICITY * overallMean) / model.meanCarbon;
            model.carbonSlopeSource = "prior";
        }
    }

    const estimates: PricePeriod[] = [];
    for (let start = from; start < until; start += PERIOD_SECONDS) {
        let price = profile(start);
        const intensity = carbonAt(start);
        if (intensity !== undefined && model.meanCarbon !== null) {
            price += model.carbonSlope * (intensity - model.meanCarbon);
        }
        estimates.push({ periodStart: start, periodEnd: start + PERIOD_SECONDS, price: Math.round(price) });
    }
    return { estimates, model };
}
