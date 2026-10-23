/**
 * Price Server HTTP API
 *
 * Endpoints for UI/external systems to push pricing and grid data updates. Prices are integers in 1/100 of the
 * currency's minor unit (e.g. 2500 = 25p/kWh), the same unit the fetchers use.
 */

import { ServerResponse } from "node:http";
import { clearCustomTariff, CURRENCY_CODES, CustomTariff, getCustomTariff, saveCustomTariff } from "../database/custom-tariff.js";
import type { PriceServer } from "./index.js";
import { getPriceSourceSettings, PriceSourceId, savePriceSourceSettings } from "../database/settings.js";

/** Saving (or using) a custom tariff selects it as the published price source */
async function selectPriceSource(priceServer: PriceServer, active: PriceSourceId) {
  const settings = await savePriceSourceSettings({ active });
  await priceServer.setPriceSource(settings.active);
}

type APIResult = { handled: boolean; statusCode?: number; response?: any };

/** Decimal points of the major unit for prices in 1/100 of the minor unit */
const PRICE_DECIMAL_POINTS = 4;

/**
 * Registers price server API endpoints
 * Call this from your main HTTP server setup
 */
export function registerPriceServerAPI(priceServer: PriceServer) {
  return async (pathname: string, method: string, body: any): Promise<APIResult> => {
    try {
      return await handle(priceServer, pathname, method, body ?? {});
    } catch (error) {
      console.error(`[PriceServerAPI] ${method} ${pathname} failed:`, error);
      return { handled: true, statusCode: 400, response: { error: (error as Error).message } };
    }
  };
}

async function handle(priceServer: PriceServer, pathname: string, method: string, body: any): Promise<APIResult> {
  // Override the current price until the end of the current half hour
  if (method === "POST" && pathname === "/api/price-server/set-price") {
    const { price, priceLevel, currency = CURRENCY_CODES.GBP } = body;
    if (!Number.isSafeInteger(price) || !isPriceLevel(priceLevel)) {
      return badRequest("price must be an integer and priceLevel 0–4");
    }
    if (!Object.values(CURRENCY_CODES).includes(currency)) return badRequest("currency must be 826 (GBP) or 978 (EUR)");
    const entry = await priceServer.overrideCurrentPrice(price, priceLevel, currency, PRICE_DECIMAL_POINTS);
    return ok({ success: true, currentPrice: entry });
  }

  // Save a day of prices as the custom tariff, repeating daily
  if (method === "POST" && pathname === "/api/price-server/set-forecast") {
    const tariff = await saveCustomTariff(tariffFromForecast(body));
    await priceServer.setCustomTariff(tariff);
    await selectPriceSource(priceServer, "custom");
    return ok({ success: true, tariff });
  }

  if (pathname === "/api/price-server/custom-tariff") {
    if (method === "GET") return ok({ tariff: await getCustomTariff() });
    if (method === "POST") {
      const tariff = await saveCustomTariff(body);
      await priceServer.setCustomTariff(tariff);
      await selectPriceSource(priceServer, "custom");
      return ok({ success: true, tariff });
    }
    if (method === "DELETE") {
      await clearCustomTariff();
      await priceServer.setCustomTariff(null);
      // Nothing left to publish from the custom source, so return to the fetched tariff used before it
      const settings = await getPriceSourceSettings();
      if (settings.active === "custom") {
        await selectPriceSource(priceServer, settings.previousTariff ?? "octopus");
      }
      return ok({ success: true });
    }
  }

  // Set current grid conditions; the carbon level is derived from the intensity
  if (method === "POST" && pathname === "/api/price-server/set-grid-conditions") {
    const { gridCarbonIntensity } = body;
    if (!Number.isInteger(gridCarbonIntensity)) return badRequest("gridCarbonIntensity must be an integer");
    await priceServer.setGridConditions(gridCarbonIntensity);
    return ok({ success: true });
  }

  // Set grid forecast; each entry lasts until the next one (the last for 30 minutes)
  if (method === "POST" && pathname === "/api/price-server/set-grid-forecast") {
    const { forecast } = body;
    if (!Array.isArray(forecast) || forecast.length === 0) return badRequest("forecast array is required");
    if (!forecast.every((e: any) => Number.isInteger(e?.time) && Number.isInteger(e?.intensity))) {
      return badRequest("Each forecast entry must have integer time and intensity");
    }
    const sorted = [...forecast].sort((a, b) => a.time - b.time);
    await priceServer.setGridForecast(
      sorted.map((entry, index) => ({
        periodStart: entry.time,
        periodEnd: sorted[index + 1]?.time ?? entry.time + 1800,
        carbonIntensity: entry.intensity,
      })),
    );
    return ok({ success: true, periods: sorted.length });
  }

  // What the CommodityPrice cluster is currently publishing (for debugging/UI)
  if (method === "GET" && pathname === "/api/price-server/price") {
    return ok(priceServer.getPublishedPrices());
  }

  // What the ElectricalGridConditions cluster is currently publishing (for debugging/UI)
  if (method === "GET" && pathname === "/api/price-server/grid-conditions") {
    return ok({ conditions: priceServer.getPublishedGridConditions() });
  }

  return { handled: false };
}

/**
 * Convert a forecast of {time, price, priceLevel} entries spanning at most a day into a daily custom tariff, merging
 * consecutive entries with the same price and level
 */
function tariffFromForecast(body: any): CustomTariff {
  const { forecast, currency = CURRENCY_CODES.GBP, tariffUnit = 0, name = "Demo tariff" } = body;
  if (!Array.isArray(forecast) || forecast.length === 0) throw new Error("forecast array is required");
  if (tariffUnit !== 0) throw new Error("Only tariffUnit 0 (kWh) is supported");
  const currencyName = (Object.keys(CURRENCY_CODES) as (keyof typeof CURRENCY_CODES)[]).find(
    key => CURRENCY_CODES[key] === currency,
  );
  if (currencyName === undefined) throw new Error("currency must be 826 (GBP) or 978 (EUR)");

  const entries = forecast
    .map((entry: any) => {
      if (!Number.isInteger(entry?.time) || !Number.isSafeInteger(entry.price) || !isPriceLevel(entry.priceLevel)) {
        throw new Error("Each forecast entry must have integer time and price, and priceLevel 0–4");
      }
      return { time: entry.time as number, price: entry.price as number, priceLevel: entry.priceLevel as number };
    })
    .sort((a, b) => a.time - b.time);
  if (entries[entries.length - 1].time - entries[0].time >= 24 * 3600) {
    throw new Error("The forecast must span less than 24 hours, as the custom tariff repeats daily");
  }

  const periods: CustomTariff["periods"] = [];
  for (const entry of entries) {
    const previous = periods[periods.length - 1];
    if (previous?.price === entry.price && previous.priceLevel === entry.priceLevel) continue;
    const local = new Date(entry.time * 1000);
    periods.push({
      startMinutes: local.getHours() * 60 + local.getMinutes(),
      price: entry.price,
      priceLevel: entry.priceLevel,
    });
  }
  // The day wraps, so the last period may continue into the first
  if (periods.length > 1) {
    const [first, last] = [periods[0], periods[periods.length - 1]];
    if (first.price === last.price && first.priceLevel === last.priceLevel) periods.shift();
  }
  return { name, currency: currencyName, periods };
}

function isPriceLevel(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 4;
}

function ok(response: any): APIResult {
  return { handled: true, statusCode: 200, response };
}

function badRequest(error: string): APIResult {
  return { handled: true, statusCode: 400, response: { error } };
}

/**
 * Helper: send JSON response
 */
export function sendPriceServerJsonResponse(response: ServerResponse, statusCode: number, data: any) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}
