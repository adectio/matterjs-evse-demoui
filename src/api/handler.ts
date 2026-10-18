import { getEstimatedPrices } from "../price-server/price-estimates.js";
import {
  getActiveCurrentPrice,
  getActivePriceForecast,
  getActivePriceMetadata,
  PriceSourceView,
  resolvePriceSource,
} from "../price-server/active-prices.js";
import { getPriceSourceSettings, savePriceSourceSettings } from "../database/settings.js";
import { getCustomTariff } from "../database/custom-tariff.js";
import { TARIFF_SOURCES, TARIFF_SOURCE_IDS } from "../fetchers/tariff-sources.js";
import { ServerResponse, IncomingMessage } from "node:http";
import {
  getPriceForecast,
  getCurrentPrice,
  getGridConditionsForecast,
  getCurrentGridConditions,
  getLatestPriceForecastMetadata,
  getLatestGridForecastMetadata,
} from "../database/queries.js";
import { getCacheStats, getCacheStatus } from "../database/cache.js";
import { triggerFetch, getFetcherStatus } from "../fetchers/scheduler.js";
import { getDatabase } from "../database/schema.js";

export async function handleApiRequest(
  pathname: string,
  method: string,
  url: URL,
  response: ServerResponse
): Promise<boolean> {
  // Commodity Price endpoints
  // Prices come from the selected price source unless ?source= names another
  if (method === "GET" && pathname === "/api/commodity-price/current") {
    const currency = url.searchParams.get("currency") || "GBP";
    const source = await resolvePriceSource(url.searchParams.get("source"));
    const price = await getActiveCurrentPrice(source, currency);
    const meta = await getActivePriceMetadata(source, currency);
    const status = await priceCacheStatus(source);

    sendJson(response, 200, {
      timestamp: new Date().toISOString(),
      current: price,
      metadata: meta,
      priceSource: source,
      cacheStatus: status,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/commodity-price/forecast") {
    const currency = url.searchParams.get("currency") || "GBP";
    const hours = parseInt(url.searchParams.get("hours") || "24");
    const from = parseFromParam(url);

    const source = await resolvePriceSource(url.searchParams.get("source"));
    const forecast = await getActivePriceForecast(source, currency, hours, from);
    const meta = await getActivePriceMetadata(source, currency);
    const status = await priceCacheStatus(source);

    // Estimated prices beyond a fetched tariff's published rates (a custom tariff repeats daily, so needs none)
    let estimated: Array<{ periodStart: number; periodEnd: number; price: number }> = [];
    let estimateModel = null;
    if (source.id !== "custom") {
      try {
        const estimate = await getEstimatedPrices(currency, "uk", hours, source.id);
        estimated = estimate.estimates;
        estimateModel = { ...estimate.model, publishedUntil: estimate.publishedUntil };
      } catch (error) {
        console.warn("Price estimate failed:", error);
      }
    }

    sendJson(response, 200, {
      timestamp: new Date().toISOString(),
      forecast,
      estimated,
      estimateModel,
      metadata: meta,
      priceSource: source,
      cacheStatus: status,
      periodCount: forecast.length,
    });
    return true;
  }

  // Grid Conditions endpoints
  if (method === "GET" && pathname === "/api/grid-conditions/current") {
    const region = url.searchParams.get("region") || "uk";
    const conditions = await getCurrentGridConditions(region);
    const meta = await getLatestGridForecastMetadata(region);
    const status = await getCacheStatus(`${region}-carbon-intensity`);

    sendJson(response, 200, {
      timestamp: new Date().toISOString(),
      current: conditions,
      metadata: meta,
      cacheStatus: status,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/grid-conditions/forecast") {
    const region = url.searchParams.get("region") || "uk";
    const hours = parseInt(url.searchParams.get("hours") || "48");
    const from = parseFromParam(url);

    const forecast = await getGridConditionsForecast(region, hours, from);
    const meta = await getLatestGridForecastMetadata(region);
    const status = await getCacheStatus(`${region}-carbon-intensity`);

    console.log(`Grid forecast query: region=${region}, hours=${hours}, results=${forecast.length}, metadata=`, meta);

    sendJson(response, 200, {
      timestamp: new Date().toISOString(),
      forecast,
      metadata: meta,
      cacheStatus: status,
      periodCount: forecast.length,
    });
    return true;
  }

  // Configuration endpoints
  // Price source selection: which tariff the price server publishes (all fetched tariffs keep updating)
  if (pathname === "/api/config/price-source") {
    if (method === "GET") {
      sendJson(response, 200, await describePriceSources());
      return true;
    }
    if (method === "POST") {
      const body = await readJsonBody(response.req);
      if (body.active === "custom" && !(await getCustomTariff())) {
        sendJson(response, 400, { error: "Save a custom tariff before selecting it." });
        return true;
      }
      const previous = await getPriceSourceSettings();
      const settings = await savePriceSourceSettings(body);
      await (globalThis as any).__priceServer?.setPriceSource(settings.active);
      // Fetch any tariff whose product or region changed (in the background)
      for (const id of TARIFF_SOURCE_IDS) {
        const before = previous.tariffs[id];
        const after = settings.tariffs[id];
        if (before.productCode !== after.productCode || before.regionCode !== after.regionCode) {
          triggerFetch(id).catch((error) => console.warn(`Refetch of ${id} failed:`, error));
        }
      }
      sendJson(response, 200, { status: "Price source saved.", ...(await describePriceSources()) });
      return true;
    }
  }

  if (method === "GET" && pathname === "/api/config/status") {
    const fetcherStatus = await getFetcherStatus();
    const cacheStats = await getCacheStats();

    sendJson(response, 200, {
      timestamp: new Date().toISOString(),
      fetchers: fetcherStatus,
      cache: {
        stats: cacheStats,
        totalEntries: cacheStats.length,
        averageHitRate:
          cacheStats.length > 0
            ? (
                cacheStats.reduce((sum: number, s: any) => sum + (s.hit_rate_percent || 0), 0) /
                cacheStats.length
              ).toFixed(1)
            : 0,
      },
    });
    return true;
  }

  // Manual fetch trigger endpoint
  const fetchTrigger = /^\/api\/admin\/fetch\/(\w+)$/.exec(pathname);
  if (method === "POST" && fetchTrigger !== null) {
    const [, fetcherName] = fetchTrigger;
    try {
      await triggerFetch(fetcherName);
      sendJson(response, 200, {
        success: true,
        message: `Triggered fetch for ${fetcherName}`,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      sendJson(response, 400, { error: (error as Error).message });
    }
    return true;
  }

  // Debug endpoint to check what's in the database
  if (method === "GET" && pathname === "/api/debug/db-status") {
    const db = await getDatabase();
    const priceCount = await db.get('SELECT COUNT(*) as count FROM commodity_prices');
    const gridCount = await db.get('SELECT COUNT(*) as count FROM grid_conditions');
    const priceSample = await db.get('SELECT * FROM commodity_prices LIMIT 1');
    const gridSample = await db.get('SELECT * FROM grid_conditions LIMIT 1');

    sendJson(response, 200, {
      priceDataPoints: priceCount?.count || 0,
      gridDataPoints: gridCount?.count || 0,
      priceSample,
      gridSample,
      now: Math.floor(Date.now() / 1000),
    });
    return true;
  }

  // Combined endpoint for dashboard
  if (method === "GET" && pathname === "/api/dashboard/data") {
    const currency = url.searchParams.get("currency") || "GBP";
    const region = url.searchParams.get("region") || "uk";
    const priceHours = parseInt(url.searchParams.get("priceHours") || "24");
    const gridHours = parseInt(url.searchParams.get("gridHours") || "48");

    const [currentPrice, priceForecast, currentConditions, gridForecast] = await Promise.all([
      getCurrentPrice(currency),
      getPriceForecast(currency, priceHours),
      getCurrentGridConditions(region),
      getGridConditionsForecast(region, gridHours),
    ]);

    const priceMeta = await getLatestPriceForecastMetadata(currency);
    const gridMeta = await getLatestGridForecastMetadata(region);
    const priceStatus = await getCacheStatus(`kraken-prices`);
    const gridStatus = await getCacheStatus(`${region}-carbon-intensity`);

    sendJson(response, 200, {
      timestamp: new Date().toISOString(),
      commodityPrice: {
        current: currentPrice,
        forecast: priceForecast,
        metadata: priceMeta,
        cacheStatus: priceStatus,
      },
      gridConditions: {
        current: currentConditions,
        forecast: gridForecast,
        metadata: gridMeta,
        cacheStatus: gridStatus,
      },
    });
    return true;
  }

  return false;
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

/** Optional `from` (Unix seconds) to include periods before now, limited to the last day */
function parseFromParam(url: URL): number | undefined {
  const value = Number(url.searchParams.get("from"));
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const now = Math.floor(Date.now() / 1000);
  return Math.max(value, now - 24 * 3600);
}

async function priceCacheStatus(source: PriceSourceView) {
  if (source.id === "custom") return "fresh";
  const settings = await getPriceSourceSettings();
  return getCacheStatus(`${source.id}-rates-${settings.tariffs[source.id].regionCode}`);
}

/** Settings plus what each source currently holds, for the configuration page */
async function describePriceSources() {
  const settings = await getPriceSourceSettings();
  const db = await getDatabase();
  const tariffs = [];
  for (const id of TARIFF_SOURCE_IDS) {
    const latest = await db.get(
      `SELECT cpf.fetched_at, COUNT(cp.id) AS rates, MAX(cp.period_end) AS published_until
       FROM commodity_price_forecasts cpf LEFT JOIN commodity_prices cp ON cp.forecast_id = cpf.id
       WHERE cpf.source_id = ? GROUP BY cpf.id ORDER BY cpf.fetched_at DESC LIMIT 1`,
      [id]
    );
    const current = await getActiveCurrentPrice(await resolvePriceSource(id), "GBP");
    tariffs.push({
      id,
      name: TARIFF_SOURCES[id].name,
      ...settings.tariffs[id],
      fetchedAt: latest?.fetched_at ?? null,
      rateCount: latest?.rates ?? 0,
      publishedUntil: latest?.published_until ?? null,
      currentPrice: current?.price ?? null,
    });
  }
  const customTariff = await getCustomTariff();
  return {
    active: settings.active,
    activeSource: await resolvePriceSource(settings.active),
    tariffs,
    customTariff: customTariff ? { name: customTariff.name, periods: customTariff.periods.length } : null,
  };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}
