import { getDatabase } from './schema.js';
import { CommodityPriceStruct, GridConditionsStruct, CommodityPriceStruct as CPStruct } from './types.js';

export async function getPriceForecast(
  currency: string,
  hours: number = 24
): Promise<CommodityPriceStruct[]> {
  const db = await getDatabase();
  const now = Math.floor(Date.now() / 1000);
  const futureSeconds = hours * 3600;

  const prices = await db.all(
    `SELECT
      cp.period_start,
      cp.period_end,
      cp.price,
      cp.price_level,
      cp.description,
      cpf.currency,
      cpf.decimals,
      cpf.tariff_unit
     FROM commodity_prices cp
     JOIN commodity_price_forecasts cpf ON cp.forecast_id = cpf.id
     WHERE cpf.currency = ?
      AND cp.period_start >= ?
      AND cp.period_start <= ?
      AND cpf.valid_until > ?
     ORDER BY cp.period_start ASC`,
    [currency, now, now + futureSeconds, now]
  ) as Array<any>;

  return prices.map((p) => ({
    periodStart: p.period_start,
    periodEnd: p.period_end,
    price: p.price,
    currency: p.currency,
    decimals: p.decimals,
    priceLevel: p.price_level,
    description: p.description,
  }));
}

export async function getCurrentPrice(currency: string): Promise<CommodityPriceStruct | null> {
  const db = await getDatabase();
  const now = Math.floor(Date.now() / 1000);

  const price = await db.get(
    `SELECT
      cp.period_start,
      cp.period_end,
      cp.price,
      cp.price_level,
      cp.description,
      cpf.currency,
      cpf.decimals,
      cpf.tariff_unit
     FROM commodity_prices cp
     JOIN commodity_price_forecasts cpf ON cp.forecast_id = cpf.id
     WHERE cpf.currency = ?
      AND cp.period_start <= ?
      AND (cp.period_end IS NULL OR cp.period_end > ?)
      AND cpf.valid_until > ?
     ORDER BY cp.period_start DESC
     LIMIT 1`,
    [currency, now, now, now]
  ) as any;

  if (!price) return null;

  return {
    periodStart: price.period_start,
    periodEnd: price.period_end,
    price: price.price,
    currency: price.currency,
    decimals: price.decimals,
    priceLevel: price.price_level,
    description: price.description,
  };
}

export async function getGridConditionsForecast(
  region: string,
  hours: number = 48
): Promise<GridConditionsStruct[]> {
  const db = await getDatabase();
  const now = Math.floor(Date.now() / 1000);
  const futureSeconds = hours * 3600;

  const conditions = await db.all(
    `SELECT
      gc.period_start,
      gc.period_end,
      gc.grid_carbon_intensity,
      gc.grid_carbon_level,
      gc.local_carbon_intensity,
      gc.local_carbon_level,
      gc.local_generation_available,
      gc.description
     FROM grid_conditions gc
     JOIN grid_conditions_forecasts gcf ON gc.forecast_id = gcf.id
     WHERE gcf.region = ?
      AND gc.period_start >= ?
      AND gc.period_start <= ?
      AND gcf.valid_until > ?
     ORDER BY gc.period_start ASC`,
    [region, now, now + futureSeconds, now]
  ) as Array<any>;

  return conditions.map((c) => ({
    periodStart: c.period_start,
    periodEnd: c.period_end,
    gridCarbonIntensity: c.grid_carbon_intensity,
    gridCarbonLevel: c.grid_carbon_level,
    localCarbonIntensity: c.local_carbon_intensity,
    localCarbonLevel: c.local_carbon_level,
    localGenerationAvailable: c.local_generation_available,
    description: c.description,
  }));
}

export async function getCurrentGridConditions(region: string): Promise<GridConditionsStruct | null> {
  const db = await getDatabase();
  const now = Math.floor(Date.now() / 1000);

  const condition = await db.get(
    `SELECT
      gc.period_start,
      gc.period_end,
      gc.grid_carbon_intensity,
      gc.grid_carbon_level,
      gc.local_carbon_intensity,
      gc.local_carbon_level,
      gc.local_generation_available,
      gc.description
     FROM grid_conditions gc
     JOIN grid_conditions_forecasts gcf ON gc.forecast_id = gcf.id
     WHERE gcf.region = ?
      AND gc.period_start <= ?
      AND (gc.period_end IS NULL OR gc.period_end > ?)
      AND gcf.valid_until > ?
     ORDER BY gc.period_start DESC
     LIMIT 1`,
    [region, now, now, now]
  ) as any;

  if (!condition) return null;

  return {
    periodStart: condition.period_start,
    periodEnd: condition.period_end,
    gridCarbonIntensity: condition.grid_carbon_intensity,
    gridCarbonLevel: condition.grid_carbon_level,
    localCarbonIntensity: condition.local_carbon_intensity,
    localCarbonLevel: condition.local_carbon_level,
    localGenerationAvailable: condition.local_generation_available,
    description: condition.description,
  };
}

export async function getLatestPriceForecastMetadata(currency: string): Promise<any> {
  const db = await getDatabase();

  const meta = await db.get(
    `SELECT
      id,
      source_id,
      currency,
      decimals,
      tariff_unit,
      period_minutes,
      fetched_at,
      valid_until
     FROM commodity_price_forecasts
     WHERE currency = ?
     ORDER BY fetched_at DESC
     LIMIT 1`,
    [currency]
  );

  return meta;
}

export async function getLatestGridForecastMetadata(region: string): Promise<any> {
  const db = await getDatabase();

  const meta = await db.get(
    `SELECT
      id,
      source_id,
      region,
      postcode,
      fetched_at,
      valid_until
     FROM grid_conditions_forecasts
     WHERE region = ?
     ORDER BY fetched_at DESC
     LIMIT 1`,
    [region]
  );

  return meta;
}

export async function deleteExpiredForecasts(): Promise<void> {
  const db = await getDatabase();
  const now = Math.floor(Date.now() / 1000);

  // Delete expired price forecasts
  await db.run(
    'DELETE FROM commodity_price_forecasts WHERE valid_until <= ?',
    [now]
  );

  // Delete expired grid forecasts
  await db.run(
    'DELETE FROM grid_conditions_forecasts WHERE valid_until <= ?',
    [now]
  );
}
