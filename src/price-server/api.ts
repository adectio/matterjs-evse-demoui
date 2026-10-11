/**
 * Price Server HTTP API
 *
 * Endpoints for UI/external systems to push pricing and grid data updates
 */

import { ServerResponse, IncomingMessage } from "node:http";
import { CommodityPriceServerBehavior, PriceData, PriceForecastEntry } from "./behaviors/commodity-price.js";
import { ElectricalGridConditionsServerBehavior, GridConditionsData, GridForecastEntry } from "./behaviors/electrical-grid-conditions.js";

export interface PriceServerAPI {
  commodityPrice: CommodityPriceServerBehavior;
  gridConditions: ElectricalGridConditionsServerBehavior;
}

/**
 * Registers price server API endpoints
 * Call this from your main HTTP server setup
 */
export function registerPriceServerAPI(api: PriceServerAPI, handleRequest: (pathname: string, method: string, body: any) => Promise<any>) {
  return async (pathname: string, method: string, body: any): Promise<{ handled: boolean; statusCode?: number; response?: any }> => {
    // Set current price
    if (method === "POST" && pathname === "/api/price-server/set-price") {
      try {
        const { price, priceLevel, currency, tariffUnit } = body;

        if (typeof price !== "number" || typeof priceLevel !== "number") {
          return { handled: true, statusCode: 400, response: { error: "price and priceLevel are required numbers" } };
        }

        const priceData: PriceData = {
          price,
          priceLevel,
          currency: currency || 826, // GBP default
          decimals: 2,
          tariffUnit: tariffUnit || 0, // kWh default
          time: Math.floor(Date.now() / 1000),
        };

        api.commodityPrice.setCurrentPrice(priceData);
        return { handled: true, statusCode: 200, response: { success: true, price: priceData } };
      } catch (error) {
        console.error("[PriceServerAPI] Error setting price:", error);
        return { handled: true, statusCode: 500, response: { error: (error as Error).message } };
      }
    }

    // Set price forecast
    if (method === "POST" && pathname === "/api/price-server/set-forecast") {
      try {
        const { currency, tariffUnit, forecast } = body;

        if (!Array.isArray(forecast) || forecast.length === 0) {
          return { handled: true, statusCode: 400, response: { error: "forecast array is required" } };
        }

        // Validate forecast entries
        const validForecast: PriceForecastEntry[] = forecast.map((entry: any) => {
          if (typeof entry.time !== "number" || typeof entry.price !== "number" || typeof entry.priceLevel !== "number") {
            throw new Error("Each forecast entry must have time, price, and priceLevel");
          }
          return {
            time: entry.time,
            price: entry.price,
            priceLevel: entry.priceLevel,
          };
        });

        api.commodityPrice.setPriceForecast(validForecast);
        return { handled: true, statusCode: 200, response: { success: true, periods: validForecast.length } };
      } catch (error) {
        console.error("[PriceServerAPI] Error setting forecast:", error);
        return { handled: true, statusCode: 400, response: { error: (error as Error).message } };
      }
    }

    // Set current grid conditions
    if (method === "POST" && pathname === "/api/price-server/set-grid-conditions") {
      try {
        const { gridCarbonIntensity, carbonLevel, region } = body;

        if (typeof gridCarbonIntensity !== "number" || typeof carbonLevel !== "number") {
          return { handled: true, statusCode: 400, response: { error: "gridCarbonIntensity and carbonLevel are required numbers" } };
        }

        const conditions: GridConditionsData = {
          gridCarbonIntensity,
          carbonLevel,
          region: region || "uk",
          time: Math.floor(Date.now() / 1000),
        };

        api.gridConditions.setCurrentConditions(conditions);
        return { handled: true, statusCode: 200, response: { success: true, conditions } };
      } catch (error) {
        console.error("[PriceServerAPI] Error setting grid conditions:", error);
        return { handled: true, statusCode: 500, response: { error: (error as Error).message } };
      }
    }

    // Set grid forecast
    if (method === "POST" && pathname === "/api/price-server/set-grid-forecast") {
      try {
        const { region, forecast } = body;

        if (!Array.isArray(forecast) || forecast.length === 0) {
          return { handled: true, statusCode: 400, response: { error: "forecast array is required" } };
        }

        // Validate forecast entries
        const validForecast: GridForecastEntry[] = forecast.map((entry: any) => {
          if (typeof entry.time !== "number" || typeof entry.intensity !== "number" || typeof entry.carbonLevel !== "number") {
            throw new Error("Each forecast entry must have time, intensity, and carbonLevel");
          }
          return {
            time: entry.time,
            intensity: entry.intensity,
            carbonLevel: entry.carbonLevel,
          };
        });

        api.gridConditions.setConditionsForecast(validForecast);
        return { handled: true, statusCode: 200, response: { success: true, periods: validForecast.length } };
      } catch (error) {
        console.error("[PriceServerAPI] Error setting grid forecast:", error);
        return { handled: true, statusCode: 400, response: { error: (error as Error).message } };
      }
    }

    // Get current price (for debugging/UI)
    if (method === "GET" && pathname === "/api/price-server/price") {
      const price = api.commodityPrice.getCurrentPrice();
      return { handled: true, statusCode: 200, response: { price } };
    }

    // Get current grid conditions (for debugging/UI)
    if (method === "GET" && pathname === "/api/price-server/grid-conditions") {
      const conditions = api.gridConditions.getCurrentConditions();
      return { handled: true, statusCode: 200, response: { conditions } };
    }

    return { handled: false };
  };
}

/**
 * Helper: send JSON response
 */
export function sendPriceServerJsonResponse(response: ServerResponse, statusCode: number, data: any) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}
