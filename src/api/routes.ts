import { Router, Request, Response } from 'express';
import {
  getPriceForecast,
  getCurrentPrice,
  getGridConditionsForecast,
  getCurrentGridConditions,
  getLatestPriceForecastMetadata,
  getLatestGridForecastMetadata,
} from '../database/queries.js';
import { getCacheStats, getCacheStatus } from '../database/cache.js';
import { triggerFetch, getFetcherStatus } from '../fetchers/scheduler.js';
import { CacheStatus } from '../database/types.js';

const router = Router();

// Commodity Price endpoints
router.get('/api/commodity-price/current', async (req: Request, res: Response) => {
  try {
    const currency = (req.query.currency as string) || 'GBP';
    const price = await getCurrentPrice(currency);
    const meta = await getLatestPriceForecastMetadata(currency);
    const status = await getCacheStatus(`kraken-prices`);

    res.json({
      timestamp: new Date().toISOString(),
      current: price,
      metadata: meta,
      cacheStatus: status,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/api/commodity-price/forecast', async (req: Request, res: Response) => {
  try {
    const currency = (req.query.currency as string) || 'GBP';
    const hours = parseInt(req.query.hours as string) || 24;

    const forecast = await getPriceForecast(currency, hours);
    const meta = await getLatestPriceForecastMetadata(currency);
    const status = await getCacheStatus(`kraken-prices`);

    res.json({
      timestamp: new Date().toISOString(),
      forecast,
      metadata: meta,
      cacheStatus: status,
      periodCount: forecast.length,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Grid Conditions endpoints
router.get('/api/grid-conditions/current', async (req: Request, res: Response) => {
  try {
    const region = (req.query.region as string) || 'uk';
    const conditions = await getCurrentGridConditions(region);
    const meta = await getLatestGridForecastMetadata(region);
    const status = await getCacheStatus(`${region}-carbon-intensity`);

    res.json({
      timestamp: new Date().toISOString(),
      current: conditions,
      metadata: meta,
      cacheStatus: status,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

router.get('/api/grid-conditions/forecast', async (req: Request, res: Response) => {
  try {
    const region = (req.query.region as string) || 'uk';
    const hours = parseInt(req.query.hours as string) || 48;

    const forecast = await getGridConditionsForecast(region, hours);
    const meta = await getLatestGridForecastMetadata(region);
    const status = await getCacheStatus(`${region}-carbon-intensity`);

    res.json({
      timestamp: new Date().toISOString(),
      forecast,
      metadata: meta,
      cacheStatus: status,
      periodCount: forecast.length,
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Configuration endpoints
router.get('/api/config/status', async (req: Request, res: Response) => {
  try {
    const fetcherStatus = await getFetcherStatus();
    const cacheStats = await getCacheStats();

    res.json({
      timestamp: new Date().toISOString(),
      fetchers: fetcherStatus,
      cache: {
        stats: cacheStats,
        totalEntries: cacheStats.length,
        averageHitRate: cacheStats.length > 0
          ? (cacheStats.reduce((sum: number, s: any) => sum + (s.hit_rate_percent || 0), 0) / cacheStats.length).toFixed(1)
          : 0,
      },
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Manual fetch trigger endpoint
router.post('/api/admin/fetch/:fetcherName', async (req: Request, res: Response) => {
  try {
    const fetcherName = req.params.fetcherName;
    await triggerFetch(fetcherName);
    res.json({
      success: true,
      message: `Triggered fetch for ${fetcherName}`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

// Combined endpoint for dashboard
router.get('/api/dashboard/data', async (req: Request, res: Response) => {
  try {
    const currency = (req.query.currency as string) || 'GBP';
    const region = (req.query.region as string) || 'uk';
    const priceHours = parseInt(req.query.priceHours as string) || 24;
    const gridHours = parseInt(req.query.gridHours as string) || 48;

    const [currentPrice, priceForecast, currentConditions, gridForecast] = await Promise.all([
      getCurrentPrice(currency),
      getPriceForecast(currency, priceHours),
      getCurrentGridConditions(region),
      getGridConditionsForecast(region, gridHours),
    ]);

    const priceMeta = await getLatestPriceForecastMetadata(currency);
    const gridMeta = await getLatestGridForecastMetadata(region);
    const priceStatus = await getCacheStatus(`kraken-prices`);
    const gridStatus = await getCacheStatus(`${region}-carbon-intensity`);

    res.json({
      timestamp: new Date().toISOString(),
      commodityPrice: {
        current: currentPrice,
        forecast: priceForecast,
        metadata: priceMeta,
        cacheStatus: priceStatus,
      },
      gridConditions: {
        current: currentConditions,
        forecast: gridForecast,
        metadata: gridMeta,
        cacheStatus: gridStatus,
      },
    });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
