import type Redis from 'ioredis';
import { getRedisClient } from './redis.js';
import { publishJson } from '../observability/trace.js';

/**
 * 统一 Redis 发布 helper：内部经 `publishJson` 在 payload 顶层注入 `_meta.traceparent`
 * （既有 `_meta` 合并、无活跃 span 时不注入无效值），消费者必须容忍 `_meta` 缺失
 * （contracts/mcp-forward-redis.md §7）。
 *
 * 所有 `.publish(` 直接调用一律归并到本 helper（T-OBS22）。
 * `client` 仅在调用方持有专用 Redis 连接时传入（如 mcp-forward-consumer 的订阅连接）；
 * 缺省使用共享 `getRedisClient()`。
 *
 * 注：实现独立于 `./redis.js`，以便单元测试以 `vi.mock('./redis.js')` stub `getRedisClient`
 * 时，本 helper 的封套逻辑仍被真实执行、发布仍落到测试桩（`mockRedis.publish`）。
 */
export function publish(
  channel: string,
  payload: Record<string, unknown>,
  client?: Redis,
): Promise<number> | number {
  const redis = client ?? getRedisClient();
  return publishJson((ch, body) => redis.publish(ch, body), channel, payload);
}
