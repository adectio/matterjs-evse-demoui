/**
 * Price Server - Matter ElectricalEnergyTariff Device
 *
 * Commissionable Matter device hosting:
 * - CommodityPrice cluster (0x0095)
 * - ElectricalGridConditions cluster (0x00A0)
 */

import { ServerNode } from "@matter/node";
import { ElectricalEnergyTariffDevice } from "@matter/node/devices";
import { CommodityPriceServer, ElectricalGridConditionsServer } from "@matter/node/behaviors";
import { registerPriceServerAPI } from "./api.js";
import { getEstimatedPrices } from "./price-estimates.js";

export { registerPriceServerAPI };
export const PRICE_SERVER_NODE_ID = 0x2000;
// Deliberately distinct from the connectedhomeip example defaults (20202021 / 3840) used by the EVSE
export const PRICE_SERVER_PASSCODE = 24681357;
export const PRICE_SERVER_DISCRIMINATOR = 0xa00;
export const PRICE_SERVER_PRODUCT_NAME = "Adectio Energy Tariff Server";

/** Description given to forecast entries that are estimates rather than the published tariff */
export const ESTIMATED_PRICE_DESCRIPTION = "Estimated";
const MAX_PRICE_FORECAST_ENTRIES = 56;
const PRICE_ESTIMATE_HOURS = 24;


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
  /** Latest published (real) tariff, so the forecast can be republished when the carbon forecast changes */
  private publishedPrices: Array<{ periodStart: number; periodEnd: number; price: number; priceLevel: string | number }> = [];

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
        // Replaces the "Matter.js Test Product" defaults; also used as the DNS-SD DN advertisement
        basicInformation: {
          vendorName: "Adectio",
          productName: PRICE_SERVER_PRODUCT_NAME,
          productLabel: "Energy Tariff",
          nodeLabel: PRICE_SERVER_PRODUCT_NAME,
          productId: 0x8001,
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
      console.log("[PriceServer]   - CommodityPrice (0x0095) ✓");
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
   * Pairing details for the admin page
   */
  getPairingInfo() {
    const commissioning = (this.serverNode?.state as any)?.commissioning;
    return {
      passcode: PRICE_SERVER_PASSCODE,
      discriminator: PRICE_SERVER_DISCRIMINATOR,
      manualPairingCode: commissioning?.pairingCodes?.manualPairingCode as string | undefined,
      qrPairingCode: commissioning?.pairingCodes?.qrPairingCode as string | undefined,
      commissioned: commissioning?.commissioned === true,
    };
  }

  /**
   * Factory reset: removes every fabric so the price server becomes commissionable again.
   * The node restarts with its configured endpoints; the fetchers repopulate prices on their next update.
   */
  async factoryReset(): Promise<void> {
    if (!this.serverNode) throw new Error("The price server is not running.");
    console.log("[PriceServer] Factory resetting...");
    await this.serverNode.erase();
    console.log("[PriceServer] Factory reset complete - commissionable again");
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
   *
   * The published tariff is followed by estimated prices (from price history and the carbon forecast)
   * up to the attribute's 56 entries, so consumers can plan beyond the published horizon.
   */
  async setPriceForecast(
    forecast: Array<{ periodStart: number; periodEnd: number; price: number; priceLevel: string | number }>
  ) {
    this.publishedPrices = forecast;
    await this.publishPriceForecast();
  }

  private async publishPriceForecast() {
    if (!this.tariffEndpoint) {
      console.warn("[PriceServer] Endpoint not available");
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const published = this.publishedPrices.filter(entry => entry.periodEnd > now);

    let estimated: Array<{ periodStart: number; periodEnd: number; price: number }> = [];
    try {
      const estimate = await getEstimatedPrices("GBP", "uk", PRICE_ESTIMATE_HOURS);
      const publishedUntil = Math.max(0, ...published.map(entry => entry.periodEnd));
      estimated = estimate.estimates.filter(entry => entry.periodStart >= publishedUntil);
    } catch (e) {
      console.warn("[PriceServer] Unable to estimate prices:", e);
    }

    try {
      await this.tariffEndpoint.act(async (agent: any) => {
        // PriceForecast is a list of CommodityPriceStruct, max 56 entries
        agent.commodityPrice.state.priceForecast = [
          ...published.map(entry => ({
            periodStart: entry.periodStart,
            periodEnd: entry.periodEnd,
            price: entry.price,
            priceLevel: mapPriceLevel(entry.priceLevel),
          })),
          ...estimated.map(entry => ({
            periodStart: entry.periodStart,
            periodEnd: entry.periodEnd,
            price: entry.price,
            description: ESTIMATED_PRICE_DESCRIPTION,
          })),
        ].slice(0, MAX_PRICE_FORECAST_ENTRIES);
      });
      console.log(`[PriceServer] Updated PriceForecast: ${published.length} published + ${estimated.length} estimated entries`);
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
      // Estimated prices depend on the carbon forecast
      if (this.publishedPrices.length > 0) await this.publishPriceForecast();
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
