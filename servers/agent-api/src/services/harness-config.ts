import { HARNESS_ACP_TYPES, HARNESS_TYPES, type HarnessType } from '../models/cloud-host.js';
import { HarnessConfig } from '../models/harness-config.js';
import { logger as rootLogger } from '../observability/logger.js';

const logger = rootLogger.child({ component: 'harness-config' });

/** 默认压缩指令（唯一来源；未配置/未命中映射时兜底） */
export const DEFAULT_COMPACT_COMMAND = '/compact';

/** 进程内缓存 TTL（60s；命中失败不回填、不缓存失败） */
export const COMPACT_COMMAND_CACHE_TTL_MS = 60_000;

/** ACP Server 类型 → Harness 类型（由 HARNESS_ACP_TYPES 反转派生，漂移守卫见 T-HCR4） */
export const ACP_SERVER_TO_HARNESS: Record<string, HarnessType> = Object.fromEntries(
  (Object.entries(HARNESS_ACP_TYPES) as Array<[HarnessType, string]>).map(([harness, acp]) => [acp, harness]),
);

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const cache = new Map<HarnessType, CacheEntry>();

/**
 * 解析指定 ACP Server 类型的压缩指令。
 *
 * - 未映射的 acpServerType → 默认 `/compact`（不查库、不缓存）；
 * - 命中映射 → 进程内缓存（TTL 60s）→ 查只读镜像；
 * - 无配置行 / 查询失败 → 默认 `/compact`；查询失败不写缓存（下次重试）。
 */
export async function resolveCompactCommand(acpServerType: string): Promise<string> {
  const harnessType = ACP_SERVER_TO_HARNESS[acpServerType];
  if (!harnessType) return DEFAULT_COMPACT_COMMAND;

  const now = Date.now();
  const cached = cache.get(harnessType);
  if (cached && cached.expiresAt > now) return cached.value;

  try {
    const doc = await HarnessConfig.findOne({ harnessType }).lean();
    const value = typeof doc?.compactCommand === 'string' && doc.compactCommand.trim()
      ? doc.compactCommand.trim()
      : DEFAULT_COMPACT_COMMAND;
    cache.set(harnessType, { value, expiresAt: now + COMPACT_COMMAND_CACHE_TTL_MS });
    return value;
  } catch (err) {
    // 短暂故障不放大为 60s 不可用：不写缓存，下次重试
    logger.warn({ event: 'compact-command-resolve-failed', harnessType, err }, 'resolve compact command failed');
    return DEFAULT_COMPACT_COMMAND;
  }
}

/** 清空缓存（仅测试使用） */
export function _clearCompactCommandCache(): void {
  cache.clear();
}

/** Harness 类型全集（漂移守卫测试与调用方复用） */
export const HARNESS_CONFIG_TYPES: readonly HarnessType[] = HARNESS_TYPES;
