import { getDatabase } from '../database/schema.js';
import { deleteExpiredForecasts } from '../database/queries.js';
import { fetchKrakenTariffRates } from './kraken-tariff.js';
import { TARIFF_SOURCE_IDS } from './tariff-sources.js';
import { fetchUKCarbonIntensity } from './carbon-intensity.js';

interface FetcherConfig {
  name: string;
  intervalMinutes: number;
  enabled: boolean;
  config: Record<string, any>;
  handler: () => Promise<void>;
}

const fetchers: Map<string, { intervalId: NodeJS.Timeout; config: FetcherConfig }> = new Map();

export async function initializeScheduler(): Promise<void> {
  const db = await getDatabase();

  // Load configuration from environment or database
  const fetcherConfigs: FetcherConfig[] = [
    // Every dynamic tariff is fetched (keeping its history current); the settings choose which is published
    ...TARIFF_SOURCE_IDS.map((sourceId) => ({
      name: sourceId,
      intervalMinutes: 60,
      enabled: true, // Kraken-platform tariff rates are public and don't need an API key
      config: {},
      handler: async () => {
        try {
          await fetchKrakenTariffRates(sourceId);
        } catch (error) {
          console.error(`${sourceId} tariff fetch error:`, error);
        }
      },
    })),
    {
      name: 'uk-carbon-intensity',
      intervalMinutes: 30,
      enabled: true,
      config: {
        postcode: process.env.UK_POSTCODE || undefined,
      },
      handler: async () => {
        try {
          await fetchUKCarbonIntensity(process.env.UK_POSTCODE);
        } catch (error) {
          console.error('Carbon Intensity fetch error:', error);
        }
      },
    },
  ];

  // Start each fetcher on its schedule
  for (const config of fetcherConfigs) {
    if (config.enabled) {
      startFetcher(config);
    }
  }

  // Start cleanup task (hourly)
  startCleanupTask();

  console.log('Data fetcher scheduler initialized');
}

function startFetcher(config: FetcherConfig): void {
  // Run immediately on startup
  config.handler().catch((error) => {
    console.error(`Initial fetch failed for ${config.name}:`, error);
  });

  // Then schedule periodic updates
  const intervalMs = config.intervalMinutes * 60 * 1000;
  const intervalId = setInterval(() => {
    config.handler().catch((error) => {
      console.error(`Scheduled fetch failed for ${config.name}:`, error);
    });
  }, intervalMs);

  fetchers.set(config.name, { intervalId, config });
  console.log(`Started fetcher: ${config.name} (every ${config.intervalMinutes} minutes)`);
}

function startCleanupTask(): void {
  const cleanupIntervalMs = 60 * 60 * 1000; // Run every hour

  // Run immediately
  deleteExpiredForecasts().catch((error) => {
    console.error('Cleanup task failed:', error);
  });

  // Schedule periodic cleanup
  setInterval(() => {
    deleteExpiredForecasts().catch((error) => {
      console.error('Cleanup task failed:', error);
    });
  }, cleanupIntervalMs);

  console.log('Started cleanup task (every 60 minutes)');
}

export async function stopScheduler(): Promise<void> {
  for (const { intervalId } of fetchers.values()) {
    clearInterval(intervalId);
  }
  fetchers.clear();
  console.log('Data fetcher scheduler stopped');
}

export async function getFetcherStatus(): Promise<any> {
  return Array.from(fetchers.entries()).map(([name, { config }]) => ({
    name,
    enabled: config.enabled,
    intervalMinutes: config.intervalMinutes,
  }));
}

export async function triggerFetch(fetcherName: string): Promise<void> {
  const fetcher = fetchers.get(fetcherName);
  if (!fetcher) {
    throw new Error(`Fetcher "${fetcherName}" not found`);
  }

  console.log(`Manually triggering fetcher: ${fetcherName}`);
  await fetcher.config.handler();
}
