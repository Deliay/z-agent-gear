import { getRedisClient } from '../middleware/redis.js';
import { Controller } from '../models/controller.js';

/** acp:options:<controllerId>:<serverType>，由 controller-api 写入 */
const ACP_OPTIONS_KEY_PREFIX = 'acp:options:';
const SCAN_BATCH_SIZE = 100;

/**
 * 按 key 模式失效 ACP 选项缓存。
 * 使用 SCAN 游标循环（禁止 KEYS），失败只告警，不阻断调用方主流程。
 */
async function deleteKeysByPattern(pattern: string): Promise<number> {
  try {
    const redis = getRedisClient();
    let cursor = '0';
    let deleted = 0;
    do {
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        SCAN_BATCH_SIZE,
      );
      cursor = String(next);
      if (keys.length > 0) {
        await redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== '0');
    return deleted;
  } catch (err) {
    console.warn(
      `[acp-options-cache] invalidate ${pattern} failed:`,
      (err as Error).message,
    );
    return 0;
  }
}

/** 失效某个控制器的全部工具选项缓存（模型/模式变更后调用）。 */
export async function invalidateAcpOptionsForController(controllerId: string): Promise<number> {
  return deleteKeysByPattern(`${ACP_OPTIONS_KEY_PREFIX}${controllerId}:*`);
}

/**
 * 失效某用户全部控制器的工具选项缓存。
 * 枚举该用户的 controllerId 后逐个 SCAN 删除。
 *
 * 注意：后台（系统内置 / global）模型由 admin-api 独立管理，跨服务不主动失效，
 * 最长由 300s TTL 兜底；用户可点「刷新」立即重取。该取舍已回写 PRD v1.2 与技术提案 v1.2。
 */
export async function invalidateAcpOptionsForUser(userId: string): Promise<number> {
  let controllers: Array<{ _id: unknown }>;
  try {
    controllers = await Controller.find({ userId }).select('_id').lean();
  } catch (err) {
    console.warn(
      '[acp-options-cache] list controllers failed:',
      (err as Error).message,
    );
    return 0;
  }
  let deleted = 0;
  for (const controller of controllers) {
    deleted += await deleteKeysByPattern(
      `${ACP_OPTIONS_KEY_PREFIX}${String(controller._id)}:*`,
    );
  }
  return deleted;
}
