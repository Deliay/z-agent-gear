import { config } from '../config/index.js';
import { getRedisClient } from '../middleware/redis.js';
import { logger as rootLogger } from '../observability/logger.js';

const logger = rootLogger.child({ component: 'agent-gear-version' });

/**
 * 最新 agent-gear 版本缓存（契约 §3.2 / 提案 §4.2）：
 * JSON `{ version, fetchedAt }`，**不设置 TTL**（保留最后已知值，由刷新任务覆盖写）。
 */
export const AGENT_GEAR_LATEST_VERSION_KEY = 'agent-gear:latest-version';

/** 版本串长度上限（与 cloud-controller `sanitizeVersionForLog` 同口径）。 */
const MAX_VERSION_LENGTH = 64;

/** registry 抓取超时（提案 §5.2 实现点 4：10s）。 */
const FETCH_TIMEOUT_MS = 10_000;

/** 进程内 single-flight：缓存 miss 时并发查询只触发一次抓取。 */
let inFlightFetch: Promise<string | null> | null = null;
/** 周期刷新定时器（unref，不阻塞进程退出）。 */
let refreshTimer: NodeJS.Timeout | null = null;

/**
 * 版本串清洗/校验：去控制字符与首尾空白；为空或超长视为非法（返回 null）。
 * 非法值按抓取失败处理，不写入缓存。
 */
export function normalizeAgentGearVersion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (!cleaned || cleaned.length > MAX_VERSION_LENGTH) return null;
  return cleaned;
}

/** 从 registry 元数据报文解析 `dist-tags.latest`（非法返回 null）。 */
export function parseLatestVersionFromRegistry(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const distTags = (payload as Record<string, unknown>)['dist-tags'];
  if (!distTags || typeof distTags !== 'object' || Array.isArray(distTags)) return null;
  return normalizeAgentGearVersion((distTags as Record<string, unknown>).latest);
}

/**
 * 从发布源抓取最新版本并回写 Redis（不读取旧值）。
 * - 使用全局 `fetch` + AbortController 10s 超时；
 * - 响应须 2xx 且 JSON 含字符串 `dist-tags.latest`，版本串须通过校验；
 * - 任何失败返回 null（调用方保留旧值 / resolver 降级），Redis 写失败仅 WARN。
 */
export async function fetchLatestAgentGearVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = config.agentGearRegistryUrl;
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn(
        { url, status: response.status },
        'agent-gear latest version fetch failed (non-2xx)',
      );
      return null;
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      logger.warn({ url }, 'agent-gear latest version fetch failed (invalid JSON)');
      return null;
    }
    const version = parseLatestVersionFromRegistry(payload);
    if (!version) {
      logger.warn({ url }, 'agent-gear latest version fetch failed (missing/invalid dist-tags.latest)');
      return null;
    }
    try {
      const redis = getRedisClient();
      await redis.set(
        AGENT_GEAR_LATEST_VERSION_KEY,
        JSON.stringify({ version, fetchedAt: new Date().toISOString() }),
      );
    } catch (err) {
      logger.warn({ err }, 'agent-gear latest version cache write failed');
    }
    return version;
  } catch (err) {
    logger.warn({ err }, 'agent-gear latest version fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** single-flight 抓取：并发调用只发起一次请求。 */
function fetchOnce(): Promise<string | null> {
  if (inFlightFetch) return inFlightFetch;
  inFlightFetch = fetchLatestAgentGearVersion().finally(() => {
    inFlightFetch = null;
  });
  return inFlightFetch;
}

/** 读取缓存版本（JSON 非法/字段缺失按 miss 处理；Redis 异常降级为 miss）。 */
async function readCachedVersion(): Promise<string | null> {
  try {
    const redis = getRedisClient();
    const raw = await redis.get(AGENT_GEAR_LATEST_VERSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { version?: unknown };
    return normalizeAgentGearVersion(parsed?.version);
  } catch (err) {
    logger.warn({ err }, 'agent-gear latest version cache read failed');
    return null;
  }
}

/**
 * 查询最新版本（resolver 唯一入口）：
 * - 命中缓存直接返回；
 * - miss → 进程内 single-flight 抓取一次并回写；抓取失败 → null（resolver 降级展示）；
 * - Redis 不可用不抛错（降级 null）。
 */
export async function getLatestAgentGearVersion(): Promise<string | null> {
  const cached = await readCachedVersion();
  if (cached) return cached;
  return fetchOnce();
}

/** 启动即刷新一次；`intervalMs` 为 0 时关闭定时刷新（仅启动一次）。 */
export function startAgentGearVersionRefresh(
  intervalMs: number = config.agentGearVersionRefreshIntervalMs,
): void {
  if (refreshTimer) return;
  void fetchOnce();
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    logger.info({ intervalMs }, 'agent-gear latest version periodic refresh disabled');
    return;
  }
  refreshTimer = setInterval(() => {
    void fetchOnce();
  }, intervalMs);
  refreshTimer.unref?.();
  logger.info({ intervalMs }, 'agent-gear latest version refresh scheduled');
}

/** 停止周期刷新（仅测试/优雅退出使用）。 */
export function stopAgentGearVersionRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/** 重置进程内状态（仅测试使用）。 */
export function resetAgentGearVersionStateForTest(): void {
  stopAgentGearVersionRefresh();
  inFlightFetch = null;
}
