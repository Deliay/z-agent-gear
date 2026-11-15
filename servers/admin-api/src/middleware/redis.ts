import Redis from 'ioredis';
import { config } from '../config/index.js';

let redisClient: Redis | null = null;

/**
 * admin-api Redis 客户端（与 agent-api `middleware/redis.ts` 同形态）。
 *
 * 用途：第三方登录一次性票据（`oauth:ticket:` / `oauth:bind-ticket:`）与 agent-api 共享同一 Redis。
 */
export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis(config.redisUri, {
      maxRetriesPerRequest: 3,
      retryStrategy(times: number) {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
    });
  }
  return redisClient;
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    redisClient.disconnect();
    redisClient = null;
  }
}
