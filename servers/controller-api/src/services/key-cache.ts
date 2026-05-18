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

export async function lookupKey(rawKey: string): Promise<CachedKey | null> {
  const redis = getRedisClient();
  const raw = await redis.get(`${RAWKEY_PREFIX}${rawKey}`);
  if (!raw) return null;
  return JSON.parse(raw) as CachedKey;
}

export async function evictKeyById(keyId: string): Promise<void> {
  const redis = getRedisClient();
  const rawKey = await redis.get(`${KEYID_PREFIX}${keyId}`);
  if (!rawKey) return;
  const pipeline = redis.pipeline();
  pipeline.del(`${RAWKEY_PREFIX}${rawKey}`);
  pipeline.del(`${KEYID_PREFIX}${keyId}`);
  await pipeline.exec();
}
