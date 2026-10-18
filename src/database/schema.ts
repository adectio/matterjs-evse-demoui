import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdir } from 'fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: Database | null = null;

export async function initializeDatabase(): Promise<Database> {
  if (db) return db;

  const dbPath = path.join(__dirname, '../../data/evse-demo.db');

  // Create data directory if it doesn't exist
  const dataDir = path.dirname(dbPath);
  await mkdir(dataDir, { recursive: true });

  db = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });

  // Enable foreign keys
  await db.exec('PRAGMA foreign_keys = ON;');

  // Create tables if they don't exist
  await createTables();

  return db;
}

async function createTables(): Promise<void> {
  if (!db) throw new Error('Database not initialized');

  // Price Sources table - define available pricing APIs
  await db.exec(`
    CREATE TABLE IF NOT EXISTS price_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      priority INTEGER NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT 1,
      api_key TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Commodity Price Forecasts - raw API data
  await db.exec(`
    CREATE TABLE IF NOT EXISTS commodity_price_forecasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      currency TEXT NOT NULL,
      decimals INTEGER NOT NULL,
      tariff_unit TEXT NOT NULL,
      period_minutes INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL,
      valid_until INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (source_id) REFERENCES price_sources(id)
    );
  `);

  // Commodity Price Data Points
  await db.exec(`
    CREATE TABLE IF NOT EXISTS commodity_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      forecast_id INTEGER NOT NULL,
      period_start INTEGER NOT NULL,
      period_end INTEGER,
      price INTEGER,
      price_level TEXT,
      description TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (forecast_id) REFERENCES commodity_price_forecasts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_period_start ON commodity_prices(period_start);
    CREATE INDEX IF NOT EXISTS idx_forecast_period ON commodity_prices(forecast_id, period_start);
  `);

  // Grid Condition Sources
  await db.exec(`
    CREATE TABLE IF NOT EXISTS grid_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      region TEXT NOT NULL,
      priority INTEGER NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT 1,
      api_key TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Grid Conditions Forecasts - raw API data
  await db.exec(`
    CREATE TABLE IF NOT EXISTS grid_conditions_forecasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      region TEXT NOT NULL,
      postcode TEXT,
      fetched_at INTEGER NOT NULL,
      valid_until INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (source_id) REFERENCES grid_sources(id)
    );
  `);

  // Grid Conditions Data Points
  await db.exec(`
    CREATE TABLE IF NOT EXISTS grid_conditions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      forecast_id INTEGER NOT NULL,
      period_start INTEGER NOT NULL,
      period_end INTEGER,
      grid_carbon_intensity INTEGER,
      grid_carbon_level TEXT,
      local_carbon_intensity INTEGER,
      local_carbon_level TEXT,
      local_generation_available BOOLEAN,
      description TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (forecast_id) REFERENCES grid_conditions_forecasts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_grid_period_start ON grid_conditions(period_start);
    CREATE INDEX IF NOT EXISTS idx_grid_forecast_period ON grid_conditions(forecast_id, period_start);
  `);

  // History (kept for HISTORY_DAYS, independent of the forecast tables which are replaced on each fetch)
  // One row per period; a later fetch of the same period replaces it
  await db.exec(`
    CREATE TABLE IF NOT EXISTS commodity_price_history (
      source_id TEXT NOT NULL,
      currency TEXT NOT NULL,
      decimals INTEGER NOT NULL,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      price INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (source_id, period_start)
    );
    CREATE TABLE IF NOT EXISTS grid_carbon_history (
      source_id TEXT NOT NULL,
      region TEXT NOT NULL,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      carbon_intensity INTEGER NOT NULL,
      is_actual BOOLEAN NOT NULL DEFAULT 0,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (source_id, region, period_start)
    );
  `);

  // Price Color Rules - thresholds for calculating price levels
  await db.exec(`
    CREATE TABLE IF NOT EXISTS price_color_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      currency TEXT NOT NULL,
      decimals INTEGER NOT NULL,
      tariff_unit TEXT NOT NULL,
      threshold1 INTEGER NOT NULL,
      threshold2 INTEGER NOT NULL,
      threshold3 INTEGER NOT NULL,
      threshold4 INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (currency, decimals, tariff_unit)
    );
  `);

  // Carbon Color Rules - thresholds for calculating carbon levels
  await db.exec(`
    CREATE TABLE IF NOT EXISTS carbon_color_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      region TEXT NOT NULL,
      threshold1 INTEGER NOT NULL,
      threshold2 INTEGER NOT NULL,
      threshold3 INTEGER NOT NULL,
      threshold4 INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (region)
    );
  `);

  // Cache Metadata - track freshness and hits
  await db.exec(`
    CREATE TABLE IF NOT EXISTS cache_metadata (
      key TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0,
      misses INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);

  // Custom ToU Tariffs - user-entered pricing
  await db.exec(`
    CREATE TABLE IF NOT EXISTS custom_tariffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      decimals INTEGER NOT NULL,
      tariff_unit TEXT NOT NULL,
      period_minutes INTEGER NOT NULL DEFAULT 30,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Custom ToU Tariff Periods
  await db.exec(`
    CREATE TABLE IF NOT EXISTS custom_tariff_periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tariff_id INTEGER NOT NULL,
      period_start_minutes INTEGER NOT NULL,
      period_end_minutes INTEGER NOT NULL,
      price INTEGER NOT NULL,
      description TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (tariff_id) REFERENCES custom_tariffs(id) ON DELETE CASCADE
    );
  `);

  // price_level was added after the table was first created
  const periodColumns = await db.all('PRAGMA table_info(custom_tariff_periods)');
  if (!periodColumns.some((column: any) => column.name === 'price_level')) {
    await db.exec('ALTER TABLE custom_tariff_periods ADD COLUMN price_level INTEGER');
  }

  // Insert default color rules if they don't exist
  await insertDefaultColorRules();
}

async function insertDefaultColorRules(): Promise<void> {
  if (!db) throw new Error('Database not initialized');

  // UK GBP default rules
  const existingGBP = await db.get(
    'SELECT id FROM price_color_rules WHERE currency = ? AND decimals = ? AND tariff_unit = ?',
    ['GBP', 3, 'kWh']
  );

  if (!existingGBP) {
    const now = Math.floor(Date.now() / 1000);
    await db.run(
      `INSERT INTO price_color_rules
       (currency, decimals, tariff_unit, threshold1, threshold2, threshold3, threshold4, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['GBP', 3, 'kWh', 200, 350, 500, 700, now, now]
    );
  }

  // EUR default rules
  const existingEUR = await db.get(
    'SELECT id FROM price_color_rules WHERE currency = ? AND decimals = ? AND tariff_unit = ?',
    ['EUR', 3, 'kWh']
  );

  if (!existingEUR) {
    const now = Math.floor(Date.now() / 1000);
    await db.run(
      `INSERT INTO price_color_rules
       (currency, decimals, tariff_unit, threshold1, threshold2, threshold3, threshold4, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['EUR', 3, 'kWh', 150, 300, 450, 650, now, now]
    );
  }

  // UK Carbon Intensity default rules
  const existingCarbonUK = await db.get(
    'SELECT id FROM carbon_color_rules WHERE region = ?',
    ['uk']
  );

  if (!existingCarbonUK) {
    const now = Math.floor(Date.now() / 1000);
    // thresholds in gCO2/kWh: very-low (0-50), low (50-150), medium (150-250), high (250-350), very-high (350+)
    await db.run(
      `INSERT INTO carbon_color_rules
       (region, threshold1, threshold2, threshold3, threshold4, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['uk', 50, 150, 250, 350, now, now]
    );
  }

  // EU Carbon Intensity default rules
  const existingCarbonEU = await db.get(
    'SELECT id FROM carbon_color_rules WHERE region = ?',
    ['eu']
  );

  if (!existingCarbonEU) {
    const now = Math.floor(Date.now() / 1000);
    await db.run(
      `INSERT INTO carbon_color_rules
       (region, threshold1, threshold2, threshold3, threshold4, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['eu', 80, 200, 350, 500, now, now]
    );
  }
}

export async function getDatabase(): Promise<Database> {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
}

export async function closeDatabase(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
  }
}
