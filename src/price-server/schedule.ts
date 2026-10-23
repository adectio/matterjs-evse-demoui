/**
 * Price schedules published by the price server
 */

import { CURRENCY_CODES, CUSTOM_TARIFF_DECIMALS, CustomTariff } from "../database/custom-tariff.js";

/** One priced period; times are Unix seconds */
export interface PriceEntry {
  periodStart: number;
  periodEnd: number;
  price: number;
  /** 0 (very low) to 4 (very high) */
  priceLevel: number;
}

export interface PriceSchedule {
  /** ISO 4217 numeric code */
  currency: number;
  /** Decimal points of the major unit, e.g. 4 for prices in 1/100 pence */
  decimalPoints: number;
  entries: PriceEntry[];
}

/** Matter allows at most 56 PriceForecast entries */
export const MAX_FORECAST_ENTRIES = 56;

/** How far ahead a daily-repeating tariff is expanded */
const DAILY_TARIFF_HORIZON_HOURS = 48;

/**
 * Expand a daily-repeating tariff into absolute periods covering now and the next 48 hours, in local time (so
 * periods follow the wall clock across DST changes).
 */
export function expandDailyTariff(tariff: CustomTariff, nowSeconds = Math.floor(Date.now() / 1000)): PriceSchedule {
  const levels = derivedPriceLevels(tariff.periods.map(p => p.price));
  const today = new Date(nowSeconds * 1000);
  const horizon = nowSeconds + DAILY_TARIFF_HORIZON_HOURS * 3600;
  const startOf = (dayOffset: number, minutes: number) =>
    Math.floor(
      new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset, 0, minutes).getTime() / 1000,
    );

  const entries: PriceEntry[] = [];
  // Start a day back so the period spanning midnight into today is included
  for (let day = -1; day <= Math.ceil(DAILY_TARIFF_HORIZON_HOURS / 24); day++) {
    tariff.periods.forEach((period, index) => {
      const next = tariff.periods[index + 1];
      const periodStart = startOf(day, period.startMinutes);
      const periodEnd = next ? startOf(day, next.startMinutes) : startOf(day + 1, tariff.periods[0].startMinutes);
      if (periodEnd > nowSeconds && periodStart < horizon) {
        entries.push({ periodStart, periodEnd, price: period.price, priceLevel: period.priceLevel ?? levels[index] });
      }
    });
  }
  return { currency: CURRENCY_CODES[tariff.currency], decimalPoints: CUSTOM_TARIFF_DECIMALS, entries };
}

/** Split the tariff's own price range into five equal bands, 0 (cheapest) to 4 (most expensive) */
export function derivedPriceLevels(prices: number[]) {
  const min = Math.min(...prices);
  const range = Math.max(...prices) - min;
  return prices.map(price => (range === 0 ? 2 : Math.min(4, Math.floor(((price - min) / range) * 5))));
}

/** Map a fetcher price level ("very-low" … "very-high") to 0–4 */
export function priceLevelNumber(level: string | number): number {
  if (typeof level === "number") return level;
  const levels: Record<string, number> = { "very-low": 0, low: 1, medium: 2, high: 3, "very-high": 4 };
  return levels[level] ?? 2;
}
