/**
 * Price Server - Matter ElectricalEnergyTariff Device
 *
 * Commissionable Matter device hosting:
 * - CommodityPrice cluster (0x0091)
 * - ElectricalGridConditions cluster (0x00A0)
 */

import { ServerNode } from "@matter/node";
import { ElectricalEnergyTariffDevice } from "@matter/node/devices";
import { CommodityPriceServer, ElectricalGridConditionsServer } from "@matter/node/behaviors";
import { registerPriceServerAPI } from "./api.js";

export { registerPriceServerAPI };
export const PRICE_SERVER_NODE_ID = 0x2000;
export const PRICE_SERVER_PASSCODE = 20202021;
export const PRICE_SERVER_DISCRIMINATOR = 0xf00;


/**
 * Map price level strings to numeric values (int16)
 */
function mapPriceLevel(level: string | number): number {
  if (typeof level === 'number') return level;

  const levelMap: Record<string, number> = {
    'very-low': 0,
    'low': 1,
    'medium': 2,
    'high': 3,
    'very-high': 4,
  };

  return levelMap[level] ?? 2; // Default to medium
}

/**
 * Map carbon intensity (gCO2/kWh) to ThreeLevelEnum: 0=Low (<100), 1=Medium, 2=High (>250)
 */
function carbonLevelFor(carbonIntensity: number): number {
  if (carbonIntensity < 100) return 0;
  if (carbonIntensity > 250) return 2;
  return 1;
}

/**
 * Price Server - Commissionable Matter Device
 */
export class PriceServer {
  private serverNode: ServerNode | null = null;
  private tariffEndpoint: any = null;
  private commodityPriceServer: CommodityPriceServer | null = null;
  private egcServer: ElectricalGridConditionsServer | null = null;
  private started = false;

  constructor() {}

  /**
   * Start the price server device
   */
  async start(): Promise<void> {
    if (this.started) return;

    try {
      console.log("[PriceServer] Creating ServerNode...");
      this.serverNode = await ServerNode.create({
        id: "energy-tariff-server",
        network: {
          port: 5541, // Use different port from controller (5540)
        },
        commissioning: {
          discriminator: PRICE_SERVER_DISCRIMINATOR,
          passcode: PRICE_SERVER_PASSCODE,
        },
      });

      console.log("[PriceServer] Composing ElectricalEnergyTariff with FORE features...");
      // Enable the FORE feature; matter.js takes feature names as strings
      const ComposedTariffDevice = ElectricalEnergyTariffDevice.with(
        CommodityPriceServer.with("Forecasting"),
        ElectricalGridConditionsServer.with("Forecasting")
      );

      console.log("[PriceServer] Adding endpoint with initial state...");
      // Mandatory attributes must be initialised or behavior initialisation fails conformance
      this.tariffEndpoint = await this.serverNode.add(ComposedTariffDevice, {
        id: "energy-tariff-endpoint",
        commodityPrice: {
          tariffUnit: 0, // kWh
          currency: { currency: 826, decimalPoints: 2 }, // GBP, pence
          currentPrice: null,
          priceForecast: [],
        },
        electricalGridConditions: {
          localGenerationAvailable: null,
          currentConditions: null,
          forecastConditions: [],
        },
      });

      // Get references to cluster servers via .agent property
      try {
        console.log("[PriceServer] Endpoint agent keys:", Object.keys(this.tariffEndpoint.agent || {}));
        console.log("[PriceServer] Full agent:", this.tariffEndpoint.agent);

        // Try different ways to access the clusters
        this.commodityPriceServer = this.tariffEndpoint.agent?.commodityPrice ||
                                    this.tariffEndpoint.state?.commodityPrice;
        this.egcServer = this.tariffEndpoint.agent?.electricalGridConditions ||
                         this.tariffEndpoint.state?.electricalGridConditions;

        console.log("[PriceServer] Endpoint created with clusters");
        console.log("[PriceServer] CommodityPrice available:", !!this.commodityPriceServer);
        console.log("[PriceServer] ElectricalGridConditions available:", !!this.egcServer);
      } catch (e) {
        console.warn("[PriceServer] Error accessing cluster servers:", e);
      }

      console.log("[PriceServer] Starting server...");
      await this.serverNode.start();

      this.started = true;

      console.log("[PriceServer] ✅ Started successfully");
      console.log(`[PriceServer] Passcode: ${PRICE_SERVER_PASSCODE}`);
      console.log(`[PriceServer] Discriminator: 0x${PRICE_SERVER_DISCRIMINATOR.toString(16)}`);
      console.log("[PriceServer] Device is now commissionable");
      console.log("[PriceServer] Clusters available:");
      console.log("[PriceServer]   - CommodityPrice (0x0091) ✓");
      console.log("[PriceServer]   - ElectricalGridConditions (0x00A0) ✓");
      console.log("[PriceServer] Update prices via: POST /api/price-server/set-price");
    } catch (error) {
      console.error("[PriceServer] Failed to start:", error);
      throw error;
    }
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    if (this.serverNode) {
      await this.serverNode.close();
    }
    this.started = false;
    console.log("[PriceServer] Stopped");
  }

  /**
   * Get HTTP API handler
   */
  getAPIHandler() {
    return registerPriceServerAPI(
      {
        commodityPrice: this.commodityPriceServer as any,
        gridConditions: this.egcServer as any,
      },
      async () => ({ handled: false })
    );
  }

  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.started;
  }

  /**
   * Update CurrentPrice attribute from fetcher data
   * @param price Price in smallest unit (e.g. pence for GBP)
   * @param priceLevel numeric level (int16)
   * @param currency Currency code (ISO 4217) - default 826 (GBP)
   * @param decimalPoints Number of decimal points - default 2 (pence)
   */
  async setCurrentPrice(
    price: number,
    priceLevel: string | number,
    periodStart: number,
    periodEnd: number,
    currency: number = 826,
    decimalPoints: number = 2
  ) {
    const mappedLevel = mapPriceLevel(priceLevel);
    console.log("[PriceServer.setCurrentPrice] Called with:", { price, priceLevel, mappedLevel, periodStart, periodEnd });
    if (!this.tariffEndpoint) {
      console.warn("[PriceServer] Endpoint not available");
      return;
    }

    try {
      // Wrap mutation inside execution context
      await this.tariffEndpoint.act(async (agent: any) => {
        // Set Currency struct with correct field names
        agent.commodityPrice.state.currency = {
          currency: currency,
          decimalPoints: decimalPoints,
        };

        // Use Unix timestamps directly (Matter epoch-s type accepts Unix seconds >= 2000-01-01)
        agent.commodityPrice.state.currentPrice = {
          periodStart,
          periodEnd,
          price,
          priceLevel: mappedLevel,
        };
      });
      console.log(`[PriceServer] Updated CurrentPrice: ${price}p`);
    } catch (e) {
      console.warn("[PriceServer] Error updating CurrentPrice:", e);
    }
  }

  /**
   * Update grid conditions from fetcher data
   * @param carbonIntensity grid carbon intensity in gCO2/kWh (int16)
   */
  async setGridConditions(carbonIntensity: number) {
    if (!this.tariffEndpoint) {
      console.warn("[PriceServer] Endpoint not available");
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    try {
      await this.tariffEndpoint.act(async (agent: any) => {
        const carbonLevel = carbonLevelFor(carbonIntensity);

        agent.electricalGridConditions.state.currentConditions = {
          periodStart: now,
          periodEnd: now + 1800, // 30-minute intervals typically
          gridCarbonIntensity: carbonIntensity,
          gridCarbonLevel: carbonLevel,
          localCarbonIntensity: carbonIntensity, // Same as grid if no local gen
          localCarbonLevel: carbonLevel,
        };
      });
      console.log(`[PriceServer] Updated GridConditions: carbonIntensity=${carbonIntensity}`);
    } catch (e) {
      console.warn("[PriceServer] Error updating GridConditions:", e);
    }
  }

  /**
   * Set price forecast (for FORECAST feature)
   */
  async setPriceForecast(
    forecast: Array<{ periodStart: number; periodEnd: number; price: number; priceLevel: string | number }>
  ) {
    if (!this.tariffEndpoint) {
      console.warn("[PriceServer] Endpoint not available");
      return;
    }
    try {
      await this.tariffEndpoint.act(async (agent: any) => {
        // PriceForecast is a list of CommodityPriceStruct, max 56 entries
        agent.commodityPrice.state.priceForecast = forecast.slice(0, 56).map(entry => ({
          periodStart: entry.periodStart,
          periodEnd: entry.periodEnd,
          price: entry.price,
          priceLevel: mapPriceLevel(entry.priceLevel),
        }));
      });
      console.log(`[PriceServer] Updated PriceForecast: ${forecast.length} entries`);
    } catch (e) {
      console.warn("[PriceServer] Error updating PriceForecast:", e);
    }
  }

  /**
   * Set grid conditions forecast
   */
  async setGridForecast(forecast: Array<{ periodStart: number; periodEnd: number; carbonIntensity: number }>) {
    if (!this.tariffEndpoint) {
      console.warn("[PriceServer] Endpoint not available");
      return;
    }
    try {
      await this.tariffEndpoint.act(async (agent: any) => {
        // ForecastConditions is a list of ElectricalGridConditionsStruct, max 56 entries
        agent.electricalGridConditions.state.forecastConditions = forecast.slice(0, 56).map(entry => {
          const carbonLevel = carbonLevelFor(entry.carbonIntensity);
          return {
            periodStart: entry.periodStart,
            periodEnd: entry.periodEnd,
            gridCarbonIntensity: entry.carbonIntensity,
            gridCarbonLevel: carbonLevel,
            localCarbonIntensity: entry.carbonIntensity,
            localCarbonLevel: carbonLevel,
          };
        });
      });
      console.log(`[PriceServer] Updated GridForecast: ${forecast.length} entries`);
    } catch (e) {
      console.warn("[PriceServer] Error updating GridForecast:", e);
    }
  }
}

/**
 * Initialize price server
 */
export async function initializePriceServer(): Promise<PriceServer> {
  const server = new PriceServer();
  await server.start();
  return server;
}

export default PriceServer;
