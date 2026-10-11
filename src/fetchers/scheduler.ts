import { getDatabase } from '../database/schema.js';
import { deleteExpiredForecasts } from '../database/queries.js';
import { fetchKrakenPrices } from './kraken.js';
import { fetchOctopusAgileRates } from './octopus.js';
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
    {
      name: 'kraken',
      intervalMinutes: 30,
      enabled: !!process.env.KRAKEN_API_KEY,
      config: {
        apiKey: process.env.KRAKEN_API_KEY || '',
      },
      handler: async () => {
        try {
          if (process.env.KRAKEN_API_KEY) {
            await fetchKrakenPrices(process.env.KRAKEN_API_KEY);
          }
        } catch (error) {
          console.error('Kraken fetch error:', error);
        }
      },
    },
    {
      name: 'octopus',
      intervalMinutes: 60,
      enabled: true, // Octopus public API doesn't require a key
      config: {
        productCode: process.env.OCTOPUS_PRODUCT_CODE || 'AGILE-24-10-01',
        regionCode: process.env.OCTOPUS_REGION || 'E',
      },
      handler: async () => {
        try {
          await fetchOctopusAgileRates(
            '', // API key not needed for public endpoint
            process.env.OCTOPUS_PRODUCT_CODE || 'AGILE-24-10-01',
            process.env.OCTOPUS_REGION || 'E'
          );
        } catch (error) {
          console.error('Octopus fetch error:', error);
        }
      },
    },
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
