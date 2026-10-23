import { createClient } from 'redis';
import { getDatabase } from './schema.js';
import { CacheStatus } from './types.js';

let redis: any = null;

const CACHE_TTL = {
  FRESH_MINUTES: 5,
  ACCEPTABLE_MINUTES: 30,
  STALE_MINUTES: 60,
};

const REDIS_TIMEOUT = 5000; // 5 second timeout, fall back to SQLite if Redis unavailable

export async function initializeRedis(): Promise<void> {
  // Skip Redis if explicitly disabled
  if (process.env.REDIS_HOST === 'disabled') {
    console.log('Redis disabled via REDIS_HOST=disabled');
    return;
  }

  try {
    redis = createClient({
      url: `redis://${process.env.REDIS_HOST || 'localhost'}:${parseInt(process.env.REDIS_PORT || '6379')}`,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            console.warn('Redis connection failed after 10 retries, continuing with SQLite-only cache');
            return new Error('Redis max retries');
          }
          return retries * 50;
        },
      },
    });

    redis.on('error', (err: Error) => {
      console.warn('Redis error, will use SQLite-only caching:', err.message);
      redis = null;
    });

    redis.on('reconnecting', () => {
      console.log('Attempting to reconnect to Redis...');
    });

    await (redis as any).connect();
    console.log('Connected to Redis');
  } catch (error) {
    console.warn('Redis unavailable, using SQLite-only caching:', (error as Error).message);
    redis = null;
  }
}

export async function getCachedData<T>(key: string, sourceId: string): Promise<T | null> {
  // Try Redis first
  if (redis) {
    try {
      const cached = await Promise.race([
        (redis as any).get(key) as Promise<string | null>,
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('Redis timeout')), REDIS_TIMEOUT)
        ),
      ]);

      if (cached) {
        await recordCacheHit(key, sourceId);
        return JSON.parse(cached);
      }
    } catch (error) {
      console.debug('Redis read failed, falling back to SQLite:', (error as Error).message);
    }
  }

  // Fall back to SQLite
  const db = await getDatabase();
  const now = Math.floor(Date.now() / 1000);

  const meta = await db.get(
    'SELECT * FROM cache_metadata WHERE key = ?',
    [key]
  ) as any;

  if (meta && meta.expires_at > now) {
    await recordCacheHit(key, sourceId);
    // Data should be in the database tables, not cache_metadata
    return null; // Caller should fetch from main tables
  }

  return null;
}

export async function setCachedData<T>(
  key: string,
  sourceId: string,
  data: T,
  ttlMinutes: number = 30
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlMinutes * 60;

  // Try Redis first
  if (redis) {
    try {
      await Promise.race([
        (redis as any).setEx(key, ttlMinutes * 60, JSON.stringify(data)),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Redis timeout')), REDIS_TIMEOUT)
        ),
      ]);
    } catch (error) {
      console.debug('Redis write failed, continuing with SQLite:', (error as Error).message);
    }
  }

  // Always update SQLite metadata
  const db = await getDatabase();
  await db.run(
    `INSERT OR REPLACE INTO cache_metadata
     (key, source_id, fetched_at, expires_at, hits, misses, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, ?)`,
    [key, sourceId, now, expiresAt, now]
  );
}

export async function recordCacheHit(key: string, sourceId: string): Promise<void> {
  const db = await getDatabase();
  await db.run(
    `UPDATE cache_metadata SET hits = hits + 1, updated_at = ? WHERE key = ?`,
    [Math.floor(Date.now() / 1000), key]
  );
}

export async function recordCacheMiss(key: string, sourceId: string): Promise<void> {
  const db = await getDatabase();
  await db.run(
    `UPDATE cache_metadata SET misses = misses + 1, updated_at = ? WHERE key = ?`,
    [Math.floor(Date.now() / 1000), key]
  );
}

export async function getCacheStatus(key: string): Promise<CacheStatus> {
  const db = await getDatabase();
  const now = Math.floor(Date.now() / 1000);

  const meta = await db.get(
    'SELECT fetched_at FROM cache_metadata WHERE key = ?',
    [key]
  ) as any;

  if (!meta) {
    return CacheStatus.EXPIRED;
  }

  const ageMinutes = (now - meta.fetched_at) / 60;

  if (ageMinutes <= CACHE_TTL.FRESH_MINUTES) return CacheStatus.FRESH;
  if (ageMinutes <= CACHE_TTL.ACCEPTABLE_MINUTES) return CacheStatus.ACCEPTABLE;
  if (ageMinutes <= CACHE_TTL.STALE_MINUTES) return CacheStatus.STALE;
  return CacheStatus.EXPIRED;
}

export async function getCacheStats(): Promise<any> {
  const db = await getDatabase();
  const stats = await db.all(
    `SELECT
      key,
      source_id,
      fetched_at,
      expires_at,
      hits,
      misses,
      (hits + misses) as total_accesses,
      CASE
        WHEN (hits + misses) > 0 THEN ROUND(CAST(hits AS FLOAT) / (hits + misses) * 100, 1)
        ELSE 0
      END as hit_rate_percent
     FROM cache_metadata
     ORDER BY total_accesses DESC`
  );
  return stats;
}

export async function invalidateCache(pattern: string): Promise<void> {
  // Redis
  if (redis) {
    try {
      const keys = await (redis as any).keys(pattern);
      if (keys.length > 0) {
        await (redis as any).del(keys);
      }
    } catch (error) {
      console.warn('Failed to invalidate Redis cache:', (error as Error).message);
    }
  }

  // SQLite
  const db = await getDatabase();
  const likePattern = pattern.replace(/\*/g, '%');
  await db.run(
    'DELETE FROM cache_metadata WHERE key LIKE ?',
    [likePattern]
  );
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    try {
      await (redis as any).disconnect();
      redis = null;
    } catch (error) {
      console.warn('Error closing Redis connection:', (error as Error).message);
    }
  }
}
