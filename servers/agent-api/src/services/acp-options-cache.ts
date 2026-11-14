import { actorFilter } from './workspace-context.js';
import { getRedisClient } from '../middleware/redis.js';
import { publish } from '../middleware/publish.js';
import { logger as rootLogger } from '../observability/logger.js';
import { Controller } from '../models/controller.js';

const logger = rootLogger.child({ component: 'acp-options-cache' });

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
    logger.warn({ pattern, err }, 'invalidate acp options cache failed');
    return 0;
  }
}

/**
 * 云电脑运行期新装 harness 成功后失效 ACP 探测缓存（实现计划裁决 16）：
 * - `acp:capability:<controllerId>`（工具可用性列表）—— 新工具需重新探测才能出现在列表；
 * - `acp:options:<controllerId>:<acpServerType>`（Mode/模型选项）—— 探测失败的空结果不应继续命中。
 * 失败只告警，不阻断安装主流程（TTL 兜底）。
 */
export async function invalidateAcpHarnessInstall(
  controllerId: string,
  acpServerType: string,
): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis.del(
      `acp:capability:${controllerId}`,
      `${ACP_OPTIONS_KEY_PREFIX}${controllerId}:${acpServerType}`,
    );
  } catch (err) {
    logger.warn({ controllerId, acpServerType, err }, 'invalidate acp caches after harness install failed');
  }
  // controller-api 的 ACPCapabilityDetector 还有 1h 进程内缓存，仅删 Redis 不会让新装 harness
  // 出现在 acpCapabilities / 工作流配置校验列表。与 refreshAcpCapabilities 同口径下发失效指令
  // （#498：补装 harness 后需立即可见、可建会话）。失败只告警，TTL 兜底。
  try {
    if (controllerId) {
      await publish('session:command', { type: 'acp:cache:invalidate', controllerId });
    }
  } catch (err) {
    logger.warn(
      { controllerId, acpServerType, err },
      'invalidate controller acp capability memory cache after harness install failed',
    );
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
    controllers = await Controller.find(actorFilter(userId)).select('_id').lean();
  } catch (err) {
    logger.warn({ userId, err }, 'list controllers failed');
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
