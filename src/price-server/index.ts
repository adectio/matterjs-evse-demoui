/**
 * Price Server - Matter ElectricalEnergyTariff Device
 *
 * Commissionable Matter device hosting:
 * - CommodityPrice cluster (0x0091)
 * - ElectricalGridConditions cluster (0x00A0)
 * - TimeSynchronization cluster (0x0038) on the root endpoint, as a trusted time source
 */

import { ServerNode } from "@matter/node";
import { ElectricalEnergyTariffDevice } from "@matter/node/devices";
import { CommodityPriceServer, ElectricalGridConditionsServer } from "@matter/node/behaviors";
import { getCustomTariff, CustomTariff } from "../database/custom-tariff.js";
import { registerPriceServerAPI } from "./api.js";
import { TimeSourceServer } from "./behaviors/time-source.js";
import { expandDailyTariff, MAX_FORECAST_ENTRIES, PriceEntry, PriceSchedule } from "./schedule.js";

export { registerPriceServerAPI };
export const PRICE_SERVER_NODE_ID = 0x2000;
// Deliberately distinct from the connectedhomeip example defaults (20202021 / 3840) used by the EVSE
export const PRICE_SERVER_PASSCODE = 24681357;
export const PRICE_SERVER_DISCRIMINATOR = 0xa00;
export const PRICE_SERVER_PRODUCT_NAME = "Adectio Energy Tariff Server";

/** How often CurrentPrice/PriceForecast are re-evaluated so CurrentPrice advances at period boundaries */
const PUBLISH_INTERVAL_MS = 30_000;

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
  private started = false;
  /** A saved custom tariff takes precedence over fetched (Octopus) prices */
  private customTariff: CustomTariff | null = null;
  private fetchedSchedule: PriceSchedule | null = null;
  /** Set via the set-price API; replaces the current price until its period ends */
  private currentPriceOverride: { schedule: PriceSchedule; entry: PriceEntry } | null = null;
  private publishTimer: NodeJS.Timeout | null = null;
  private publishing = Promise.resolve();

  constructor() {}

  /**
   * Start the price server device
   */
  async start(): Promise<void> {
    if (this.started) return;

    try {
      console.log("[PriceServer] Creating ServerNode...");
      this.serverNode = await ServerNode.create(ServerNode.RootEndpoint.with(TimeSourceServer), {
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

      console.log("[PriceServer] Starting server...");
      await this.serverNode.start();

      this.started = true;

      try {
        this.customTariff = await getCustomTariff();
      } catch (e) {
        console.warn("[PriceServer] Could not load the custom tariff:", e);
      }
      await this.publishPrices();
      this.publishTimer = setInterval(() => void this.publishPrices(), PUBLISH_INTERVAL_MS);

      console.log("[PriceServer] ✅ Started successfully");
      console.log(`[PriceServer] Passcode: ${PRICE_SERVER_PASSCODE}`);
      console.log(`[PriceServer] Discriminator: 0x${PRICE_SERVER_DISCRIMINATOR.toString(16)}`);
      console.log("[PriceServer] Device is now commissionable");
      console.log("[PriceServer] Clusters available:");
      console.log("[PriceServer]   - CommodityPrice (0x0091) ✓");
      console.log("[PriceServer]   - ElectricalGridConditions (0x00A0) ✓");
      console.log("[PriceServer]   - TimeSynchronization (0x0038) on endpoint 0 ✓");
      console.log(`[PriceServer] Price source: ${this.customTariff ? `custom tariff "${this.customTariff.name}"` : "fetched prices"}`);
    } catch (error) {
      console.error("[PriceServer] Failed to start:", error);
      throw error;
    }
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    if (this.publishTimer) clearInterval(this.publishTimer);
    this.publishTimer = null;
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
    return registerPriceServerAPI(this);
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
   * Check if running
   */
  isRunning(): boolean {
    return this.started;
  }

  /**
   * Use a custom daily tariff in place of fetched prices; null reverts to fetched prices
   */
  async setCustomTariff(tariff: CustomTariff | null) {
    this.customTariff = tariff;
    this.currentPriceOverride = null;
    await this.publishPrices();
  }

  /**
   * Prices from a fetcher (e.g. Octopus Agile); published only while no custom tariff is set
   */
  async setFetchedSchedule(schedule: PriceSchedule) {
    this.fetchedSchedule = schedule;
    await this.publishPrices();
  }

  /**
   * Replace CurrentPrice until the end of the current half hour, after which the active schedule resumes
   */
  async overrideCurrentPrice(price: number, priceLevel: number, currency: number, decimalPoints: number) {
    const now = Math.floor(Date.now() / 1000);
    const periodStart = now - (now % 1800);
    const entry = { periodStart, periodEnd: periodStart + 1800, price, priceLevel };
    this.currentPriceOverride = { schedule: { currency, decimalPoints, entries: [entry] }, entry };
    await this.publishPrices();
    return entry;
  }

  /**
   * What is being published, read back from the CommodityPrice cluster
   */
  getPublishedPrices() {
    const state = this.tariffEndpoint?.state?.commodityPrice;
    return {
      source: this.currentPriceOverride ? "override" : this.customTariff ? "custom" : this.fetchedSchedule ? "fetched" : "none",
      customTariff: this.customTariff?.name ?? null,
      currency: state?.currency ?? null,
      currentPrice: state?.currentPrice ?? null,
      priceForecast: state?.priceForecast ?? [],
    };
  }

  /**
   * What the ElectricalGridConditions cluster is currently publishing
   */
  getPublishedGridConditions() {
    return this.tariffEndpoint?.state?.electricalGridConditions?.currentConditions ?? null;
  }

  /**
   * Write CurrentPrice and PriceForecast from the active schedule; serialised so overlapping calls don't interleave
   */
  private publishPrices() {
    this.publishing = this.publishing.then(() => this.writePrices()).catch(e => {
      console.warn("[PriceServer] Error publishing prices:", e);
    });
    return this.publishing;
  }

  private async writePrices() {
    if (!this.tariffEndpoint) return;
    const now = Math.floor(Date.now() / 1000);
    if (this.currentPriceOverride && this.currentPriceOverride.entry.periodEnd <= now) {
      this.currentPriceOverride = null;
    }

    const schedule = this.customTariff ? expandDailyTariff(this.customTariff, now) : this.fetchedSchedule;
    const upcoming = (schedule?.entries ?? [])
      .filter(entry => entry.periodEnd > now)
      .sort((a, b) => a.periodStart - b.periodStart);
    const current = this.currentPriceOverride?.entry ?? upcoming.find(entry => entry.periodStart <= now) ?? null;
    const { currency, decimalPoints } = this.currentPriceOverride?.schedule ?? schedule ?? { currency: 826, decimalPoints: 4 };

    const next = {
      currency: { currency, decimalPoints },
      currentPrice: current,
      priceForecast: upcoming.slice(0, MAX_FORECAST_ENTRIES),
    };
    const state = this.tariffEndpoint.state.commodityPrice;
    if (JSON.stringify(next) === JSON.stringify({ currency: state.currency, currentPrice: state.currentPrice, priceForecast: state.priceForecast })) {
      return;
    }

    await this.tariffEndpoint.act(async (agent: any) => {
      agent.commodityPrice.state.currency = next.currency;
      agent.commodityPrice.state.currentPrice = next.currentPrice;
      agent.commodityPrice.state.priceForecast = next.priceForecast;
    });
    console.log(
      `[PriceServer] Published CurrentPrice=${current?.price ?? "null"} (decimalPoints=${decimalPoints}), ` +
        `${next.priceForecast.length} forecast entries`,
    );
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
