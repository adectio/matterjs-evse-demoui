import { getEstimatedPrices } from "../price-server/price-estimates.js";
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
  if (method === "GET" && pathname === "/api/commodity-price/current") {
    const currency = url.searchParams.get("currency") || "GBP";
    const price = await getCurrentPrice(currency);
    const meta = await getLatestPriceForecastMetadata(currency);
    const status = await getCacheStatus(`kraken-prices`);

    sendJson(response, 200, {
      timestamp: new Date().toISOString(),
      current: price,
      metadata: meta,
      cacheStatus: status,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/commodity-price/forecast") {
    const currency = url.searchParams.get("currency") || "GBP";
    const hours = parseInt(url.searchParams.get("hours") || "24");
    const from = parseFromParam(url);

    const forecast = await getPriceForecast(currency, hours, from);
    const meta = await getLatestPriceForecastMetadata(currency);
    const status = await getCacheStatus(`kraken-prices`);

    console.log(`Price forecast query: currency=${currency}, hours=${hours}, results=${forecast.length}, metadata=`, meta);

    // Estimated prices beyond the published tariff (from price history and the carbon forecast)
    let estimated: Array<{ periodStart: number; periodEnd: number; price: number }> = [];
    let estimateModel = null;
    try {
      const estimate = await getEstimatedPrices(currency, "uk", hours);
      estimated = estimate.estimates;
      estimateModel = { ...estimate.model, publishedUntil: estimate.publishedUntil };
    } catch (error) {
      console.warn("Price estimate failed:", error);
    }

    sendJson(response, 200, {
      timestamp: new Date().toISOString(),
      forecast,
      estimated,
      estimateModel,
      metadata: meta,
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
