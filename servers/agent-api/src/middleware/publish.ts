import { getRedisClient } from './redis.js';
import { publishJson } from '../observability/trace.js';

/**
 * Redis 发布封套（T-OBS13）：payload 顶层注入 `_meta.traceparent` 后序列化发布。
 *
 * 全包发布点统一走此 helper，Redis 直接 publish 仅存在于下方 `publishJson` 回调内；
 * 消费方必须容忍 `_meta` 缺失（历史报文兼容，见 contracts/mcp-forward-redis.md §7）。
 *
 * 独立于 `middleware/redis.js`：测试 mock `redis.js` 时本 helper 保持真实实现，
 * 经 mock 的 `getRedisClient()` 落到 `mockRedis.publish`，同时保留真实 `publishJson` 封套。
 */
export async function publish(channel: string, payload: Record<string, unknown>): Promise<number> {
  return (await publishJson((ch, body) => getRedisClient().publish(ch, body), channel, payload)) as number;
}
