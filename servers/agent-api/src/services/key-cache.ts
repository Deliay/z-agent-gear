import { getRedisClient } from '../middleware/redis.js';

const RAWKEY_PREFIX = 'controller:rawkey:';
const KEYID_PREFIX = 'controller:keyid:';
const CACHE_TTL = 60 * 60 * 24 * 30; // 30 days

interface CachedKey {
  keyId: string;
  keyHash: string;
  userId: string;
  status: string;
  type: string;
}

export async function cacheKey(rawKey: string, data: CachedKey): Promise<void> {
  const redis = getRedisClient();
  const rawKeyKv = `${RAWKEY_PREFIX}${rawKey}`;
  const keyIdKv = `${KEYID_PREFIX}${data.keyId}`;
  const pipeline = redis.pipeline();
  pipeline.set(rawKeyKv, JSON.stringify(data), 'EX', CACHE_TTL);
  pipeline.set(keyIdKv, rawKey, 'EX', CACHE_TTL);
  await pipeline.exec();
}

export async function lookupKey(rawKey: string): Promise<CachedKey | null> {
  const redis = getRedisClient();
  const raw = await redis.get(`${RAWKEY_PREFIX}${rawKey}`);
  if (!raw) return null;
  return JSON.parse(raw) as CachedKey;
}

export async function getRawKeyById(keyId: string): Promise<string | null> {
  try {
    const redis = getRedisClient();
    return await redis.get(`${KEYID_PREFIX}${keyId}`);
  } catch {
    return null;
  }
}

export async function evictKeyById(keyId: string): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const rawKey = await redis.get(`${KEYID_PREFIX}${keyId}`);
    if (!rawKey) return true;
    const pipeline = redis.pipeline();
    pipeline.del(`${RAWKEY_PREFIX}${rawKey}`);
    pipeline.del(`${KEYID_PREFIX}${keyId}`);
    await pipeline.exec();
    return true;
  } catch (err) {
    console.error(`Failed to evict key ${keyId} from cache:`, err);
    return false;
  }
}
