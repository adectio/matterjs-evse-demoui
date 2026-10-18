/**
 * Price Server - Matter ElectricalEnergyTariff Device
 *
 * Commissionable Matter device hosting:
 * - CommodityPrice cluster (0x0095)
 * - ElectricalGridConditions cluster (0x00A0)
 * - TimeSynchronization cluster (0x0038) on the root endpoint, as a trusted time source
 */

import { ServerNode } from "@matter/node";
import { ElectricalEnergyTariffDevice } from "@matter/node/devices";
import { CommodityPriceServer, ElectricalGridConditionsServer } from "@matter/node/behaviors";
import { getCustomTariff, CustomTariff } from "../database/custom-tariff.js";
import { getPriceSourceSettings, PriceSourceId, priceSourceName } from "../database/settings.js";
import type { TariffSourceId } from "../fetchers/tariff-sources.js";
import { registerPriceServerAPI } from "./api.js";
import { TimeSourceServer } from "./behaviors/time-source.js";
import { getEstimatedPrices } from "./price-estimates.js";
import { expandDailyTariff, MAX_FORECAST_ENTRIES, PriceEntry, PriceSchedule } from "./schedule.js";

export { registerPriceServerAPI };
export const PRICE_SERVER_NODE_ID = 0x2000;
// Deliberately distinct from the connectedhomeip example defaults (20202021 / 3840) used by the EVSE
export const PRICE_SERVER_PASSCODE = 24681357;
export const PRICE_SERVER_DISCRIMINATOR = 0xa00;
export const PRICE_SERVER_PRODUCT_NAME = "Adectio Energy Tariff Server";

/** How often CurrentPrice/PriceForecast are re-evaluated so CurrentPrice advances at period boundaries */
const PUBLISH_INTERVAL_MS = 30_000;

/** Description given to forecast entries that are estimates rather than the published tariff */
export const ESTIMATED_PRICE_DESCRIPTION = "Estimated";
const PRICE_ESTIMATE_HOURS = 24;

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
  /** Which prices are published: a fetched tariff or the custom tariff (from the price source settings) */
  private priceSource: PriceSourceId = "octopus";
  private customTariff: CustomTariff | null = null;
  /** Latest prices of every fetched tariff, so switching source takes effect immediately */
  private fetchedSchedules = new Map<TariffSourceId, PriceSchedule>();
  /** Set via the set-price API; replaces the current price until its period ends */
  private currentPriceOverride: { schedule: PriceSchedule; entry: PriceEntry } | null = null;
  private publishTimer: NodeJS.Timeout | null = null;
  private publishing = Promise.resolve();
  /**
   * Estimated prices following the fetched schedule (from price history and the carbon forecast). Refreshed when
   * the fetched prices or carbon forecast change, rather than on every publish.
   */
  private estimatedEntries: Array<{ periodStart: number; periodEnd: number; price: number }> = [];

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
          currency: { currency: 826, decimalPoints: 4 }, // GBP, prices in 1/100 pence
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
        this.priceSource = (await getPriceSourceSettings()).active;
      } catch (e) {
        console.warn("[PriceServer] Could not load the price source settings:", e);
      }
      await this.publishPrices();
      this.publishTimer = setInterval(() => void this.publishPrices(), PUBLISH_INTERVAL_MS);

      console.log("[PriceServer] ✅ Started successfully");
      console.log(`[PriceServer] Passcode: ${PRICE_SERVER_PASSCODE}`);
      console.log(`[PriceServer] Discriminator: 0x${PRICE_SERVER_DISCRIMINATOR.toString(16)}`);
      console.log("[PriceServer] Device is now commissionable");
      console.log("[PriceServer] Clusters available:");
      console.log("[PriceServer]   - CommodityPrice (0x0095) ✓");
      console.log("[PriceServer]   - ElectricalGridConditions (0x00A0) ✓");
      console.log("[PriceServer]   - TimeSynchronization (0x0038) on endpoint 0 ✓");
      console.log(`[PriceServer] Price source: ${this.describePriceSource()}`);
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
   * The custom daily tariff (published while the custom price source is selected); null when none is saved
   */
  async setCustomTariff(tariff: CustomTariff | null) {
    this.customTariff = tariff;
    this.currentPriceOverride = null;
    await this.publishPrices();
  }

  /**
   * Prices from a tariff fetcher; published while that tariff is the selected price source
   */
  async setFetchedSchedule(sourceId: TariffSourceId, schedule: PriceSchedule) {
    this.fetchedSchedules.set(sourceId, schedule);
    if (sourceId === this.priceSource) {
      await this.refreshEstimates();
      await this.publishPrices();
    }
  }

  /** Switch the published prices to another source */
  async setPriceSource(source: PriceSourceId) {
    if (source === this.priceSource) return;
    this.priceSource = source;
    this.currentPriceOverride = null;
    this.estimatedEntries = [];
    await this.refreshEstimates();
    await this.publishPrices();
    console.log(`[PriceServer] Price source changed to ${this.describePriceSource()}`);
  }

  describePriceSource() {
    if (this.priceSource === "custom") {
      return this.customTariff ? `Custom tariff "${this.customTariff.name}"` : "Custom tariff (none saved)";
    }
    return priceSourceName(this.priceSource);
  }

  /** Recompute the estimated prices that follow the selected fetched tariff */
  private async refreshEstimates() {
    if (this.priceSource === "custom") {
      this.estimatedEntries = [];
      return;
    }
    try {
      const estimate = await getEstimatedPrices("GBP", "uk", PRICE_ESTIMATE_HOURS, this.priceSource);
      this.estimatedEntries = estimate.estimates;
    } catch (e) {
      console.warn("[PriceServer] Unable to estimate prices:", e);
    }
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
      source: this.currentPriceOverride ? "override" : this.priceSource,
      sourceName: this.describePriceSource(),
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
    // The node can be taken offline (e.g. matter.js closes it on SIGINT) before the publish timer is stopped
    if (!this.tariffEndpoint || !this.serverNode?.lifecycle.isOnline) return;
    const now = Math.floor(Date.now() / 1000);
    if (this.currentPriceOverride && this.currentPriceOverride.entry.periodEnd <= now) {
      this.currentPriceOverride = null;
    }

    const custom = this.priceSource === "custom";
    const schedule = custom
      ? this.customTariff
        ? expandDailyTariff(this.customTariff, now)
        : null
      : this.fetchedSchedules.get(this.priceSource as TariffSourceId) ?? null;
    const upcoming = (schedule?.entries ?? [])
      .filter(entry => entry.periodEnd > now)
      .sort((a, b) => a.periodStart - b.periodStart);
    const current = this.currentPriceOverride?.entry ?? upcoming.find(entry => entry.periodStart <= now) ?? null;
    const { currency, decimalPoints } = this.currentPriceOverride?.schedule ?? schedule ?? { currency: 826, decimalPoints: 4 };

    // Fetched prices only cover what has been published, so estimates continue the forecast beyond them.
    // A custom tariff repeats daily and needs none; an override doesn't change the forecast.
    const publishedUntil = Math.max(now, ...upcoming.map(entry => entry.periodEnd));
    const estimated = custom
      ? []
      : this.estimatedEntries
          .filter(entry => entry.periodStart >= publishedUntil)
          .map(entry => ({ ...entry, description: ESTIMATED_PRICE_DESCRIPTION }));

    const next = {
      currency: { currency, decimalPoints },
      currentPrice: current,
      priceForecast: [...upcoming, ...estimated].slice(0, MAX_FORECAST_ENTRIES),
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
        `${next.priceForecast.length} forecast entries (${estimated.length} estimated)`,
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
      // Estimated prices depend on the carbon forecast
      await this.refreshEstimates();
      await this.publishPrices();
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
