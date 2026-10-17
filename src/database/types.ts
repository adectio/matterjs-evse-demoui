// Commodity Price Types
export interface CommodityPriceStruct {
  periodStart: number;      // Unix timestamp (seconds)
  periodEnd?: number;       // Unix timestamp (seconds) - optional
  price?: number;           // Price value in smallest currency unit
  currency?: string;        // ISO 4217 code (e.g., "GBP", "EUR")
  decimals?: number;        // Decimal places for the price
  priceLevel?: PriceLevel;  // Calculated color level
  description?: string;
}

export interface PriceSource {
  id: string;               // Unique identifier (e.g., "kraken", "octopus", "custom")
  name: string;
  priority: number;         // Lower number = higher priority
  enabled: boolean;
  apiKey?: string;          // Encrypted in database
  metadata?: Record<string, unknown>;
}

export interface PriceForecast {
  sourceId: string;
  currency: string;
  decimals: number;
  tariffUnit: string;       // "kWh", "kW", etc.
  periodMinutes: number;    // 30 for half-hourly, 60 for hourly
  prices: CommodityPriceStruct[];
  fetchedAt: number;        // Unix timestamp
  validUntil: number;       // Unix timestamp when this forecast expires
}

// Grid Conditions Types
export interface GridConditionsStruct {
  periodStart: number;
  periodEnd?: number;
  gridCarbonIntensity?: number;        // grams CO2/kWh
  gridCarbonLevel?: CarbonLevel;       // Calculated color level
  localCarbonIntensity?: number;
  localCarbonLevel?: CarbonLevel;
  localGenerationAvailable?: boolean;
  description?: string;
}

export interface GridConditionsForecast {
  sourceId: string;
  region: string;           // e.g., "uk", "de", "fr"
  postcode?: string;        // For UK regional selection
  conditions: GridConditionsStruct[];
  fetchedAt: number;
  validUntil: number;
}

// Color/Level Enums
export enum PriceLevel {
  VERY_LOW = "very-low",    // Green
  LOW = "low",              // Light green
  MEDIUM = "medium",        // Yellow
  HIGH = "high",            // Orange
  VERY_HIGH = "very-high",  // Red
}

export enum CarbonLevel {
  VERY_LOW = "very-low",    // Green (very clean)
  LOW = "low",              // Light green (clean)
  MEDIUM = "medium",        // Yellow (moderate)
  HIGH = "high",            // Orange (dirty)
  VERY_HIGH = "very-high",  // Red (very dirty)
}

// Color Rule Types
export interface PriceColorRule {
  id: number;
  currency: string;
  decimals: number;
  tariffUnit: string;
  threshold1: number;       // Very low → low threshold
  threshold2: number;       // Low → medium threshold
  threshold3: number;       // Medium → high threshold
  threshold4: number;       // High → very high threshold
  createdAt: number;
  updatedAt: number;
}

export interface CarbonColorRule {
  id: number;
  region: string;
  threshold1: number;       // Very low → low (gCO2/kWh)
  threshold2: number;       // Low → medium
  threshold3: number;       // Medium → high
  threshold4: number;       // High → very high
  createdAt: number;
  updatedAt: number;
}

// Cache Metadata
export interface CacheEntry {
  key: string;
  sourceId: string;
  fetchedAt: number;
  expiresAt: number;
  hits: number;
  misses: number;
}

export enum CacheStatus {
  FRESH = "fresh",          // 0-5 minutes old
  ACCEPTABLE = "acceptable", // 5-30 minutes old
  STALE = "stale",          // 30-60 minutes old
  EXPIRED = "expired",      // >60 minutes old
}
