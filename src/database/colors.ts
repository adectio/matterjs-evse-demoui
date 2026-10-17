import { PriceLevel, CarbonLevel, PriceColorRule, CarbonColorRule } from './types.js';
import { getDatabase } from './schema.js';

export async function calculatePriceLevel(
  price: number,
  currency: string,
  decimals: number,
  tariffUnit: string
): Promise<PriceLevel> {
  const db = await getDatabase();

  const rule = await db.get(
    `SELECT threshold1, threshold2, threshold3, threshold4
     FROM price_color_rules
     WHERE currency = ? AND decimals = ? AND tariff_unit = ?`,
    [currency, decimals, tariffUnit]
  ) as PriceColorRule | undefined;

  if (!rule) {
    // Fallback if no rule defined
    return PriceLevel.MEDIUM;
  }

  if (price <= rule.threshold1) return PriceLevel.VERY_LOW;
  if (price <= rule.threshold2) return PriceLevel.LOW;
  if (price <= rule.threshold3) return PriceLevel.MEDIUM;
  if (price <= rule.threshold4) return PriceLevel.HIGH;
  return PriceLevel.VERY_HIGH;
}

export async function calculateCarbonLevel(
  intensity: number,
  region: string
): Promise<CarbonLevel> {
  const db = await getDatabase();

  const rule = await db.get(
    `SELECT threshold1, threshold2, threshold3, threshold4
     FROM carbon_color_rules
     WHERE region = ?`,
    [region]
  ) as CarbonColorRule | undefined;

  if (!rule) {
    // Fallback if no rule defined
    return CarbonLevel.MEDIUM;
  }

  if (intensity <= rule.threshold1) return CarbonLevel.VERY_LOW;
  if (intensity <= rule.threshold2) return CarbonLevel.LOW;
  if (intensity <= rule.threshold3) return CarbonLevel.MEDIUM;
  if (intensity <= rule.threshold4) return CarbonLevel.HIGH;
  return CarbonLevel.VERY_HIGH;
}

export function getLevelColor(level: PriceLevel | CarbonLevel): string {
  switch (level) {
    case PriceLevel.VERY_LOW:
    case CarbonLevel.VERY_LOW:
      return '#00a651'; // Dark green
    case PriceLevel.LOW:
    case CarbonLevel.LOW:
      return '#7cb342'; // Light green
    case PriceLevel.MEDIUM:
    case CarbonLevel.MEDIUM:
      return '#fbc02d'; // Yellow
    case PriceLevel.HIGH:
    case CarbonLevel.HIGH:
      return '#f57c00'; // Orange
    case PriceLevel.VERY_HIGH:
    case CarbonLevel.VERY_HIGH:
      return '#d32f2f'; // Red
    default:
      return '#9e9e9e'; // Gray fallback
  }
}

export async function updatePriceLevelForForecast(forecastId: number): Promise<void> {
  const db = await getDatabase();

  // Get forecast details
  const forecast = await db.get(
    `SELECT currency, decimals, tariff_unit FROM commodity_price_forecasts WHERE id = ?`,
    [forecastId]
  ) as any;

  if (!forecast) return;

  // Get all prices in this forecast
  const prices = await db.all(
    `SELECT id, price FROM commodity_prices WHERE forecast_id = ? AND price IS NOT NULL`,
    [forecastId]
  ) as Array<{ id: number; price: number }>;

  // Update each price with its calculated level
  for (const { id, price } of prices) {
    const level = await calculatePriceLevel(price, forecast.currency, forecast.decimals, forecast.tariff_unit);
    await db.run(
      `UPDATE commodity_prices SET price_level = ? WHERE id = ?`,
      [level, id]
    );
  }
}

export async function updateCarbonLevelForForecast(forecastId: number, region: string): Promise<void> {
  const db = await getDatabase();

  // Get all conditions in this forecast
  const conditions = await db.all(
    `SELECT id, grid_carbon_intensity, local_carbon_intensity FROM grid_conditions WHERE forecast_id = ?`,
    [forecastId]
  ) as Array<{ id: number; grid_carbon_intensity?: number; local_carbon_intensity?: number }>;

  // Update each condition with its calculated levels
  for (const { id, grid_carbon_intensity, local_carbon_intensity } of conditions) {
    let gridLevel: CarbonLevel | null = null;
    let localLevel: CarbonLevel | null = null;

    if (grid_carbon_intensity !== null && grid_carbon_intensity !== undefined) {
      gridLevel = await calculateCarbonLevel(grid_carbon_intensity, region);
    }
    if (local_carbon_intensity !== null && local_carbon_intensity !== undefined) {
      localLevel = await calculateCarbonLevel(local_carbon_intensity, region);
    }

    await db.run(
      `UPDATE grid_conditions SET grid_carbon_level = ?, local_carbon_level = ? WHERE id = ?`,
      [gridLevel || null, localLevel || null, id]
    );
  }
}
