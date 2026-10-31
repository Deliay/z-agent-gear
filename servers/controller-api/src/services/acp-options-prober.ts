import type { Socket } from 'socket.io';
import { getRedisClient } from '../middleware/redis.js';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';
import { harnessLoginRegistry, type HarnessLoginRegistry } from './harness-login-registry.js';

export interface AcpServerOptionsData {
  modes: Array<{ id: string; name: string; description?: string }>;
  models: Array<{ id: string; name: string; provider?: string }>;
  currentModeId: string | null;
  currentModelId: string | null;
  probedAt: string | null;
}

interface ProbeRequest {
  requestId: string;
  controllerId: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (options: AcpServerOptionsData) => void;
}

interface ProbeResultPayload {
  requestId: string;
  serverType: string;
  success: boolean;
  modes?: Array<{ id: string; name: string; description?: string }>;
  availableModels?: Array<{ id: string; name: string; provider?: string }>;
  currentModeId?: string | null;
  currentModelId?: string | null;
  error?: string;
}

const EMPTY_OPTIONS: AcpServerOptionsData = {
  modes: [],
  models: [],
  currentModeId: null,
  currentModelId: null,
  probedAt: null,
};

const SUCCESS_CACHE_TTL = 300; // 5 分钟：模式/模型选项短时有效，模型列表变更后由 agent-api 主动失效
const FAILURE_CACHE_TTL = 60; // 失败结果短缓存：让 agent-api 轮询尽快返回，同时允许快速重试
const PROBE_TIMEOUT_MS = 30_000;
// 登录进行中时的超时重挂间隔（与登录等待上限无关，仅决定复检节奏）
const LOGIN_GUARD_REARM_MS = 30_000;

function cacheKey(controllerId: string, serverType: string): string {
  return `acp:options:${controllerId}:${serverType}`;
}

/**
 * ACP 工具 Mode/模型选项探测：向 controller 发送 acp:probe-options，
 * 由 agent-controller 拉起空实例（session/new）收集选项后关闭。
 * 结果按 controllerId+serverType 缓存到 Redis。
 */
export class AcpOptionsProber {
  private pendingRequests = new Map<string, ProbeRequest>();
  private readonly registry: HarnessLoginRegistry;
  private readonly logger: ObservationLogger;

  constructor(
    registry: HarnessLoginRegistry = harnessLoginRegistry,
    logger: ObservationLogger = rootLogger.child({ component: 'acp-options-prober' }),
  ) {
    this.registry = registry;
    this.logger = logger;
  }

  async probeOptions(
    controllerSocket: Socket,
    controllerId: string,
    serverType: string,
  ): Promise<AcpServerOptionsData> {
    const redis = getRedisClient();
    const key = cacheKey(controllerId, serverType);

    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached) as AcpServerOptionsData;
    }

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve) => {
      const entry: ProbeRequest = {
        requestId,
        controllerId,
        timeout: undefined as unknown as ReturnType<typeof setTimeout>,
        resolve: (options) => {
          clearTimeout(entry.timeout);
          this.pendingRequests.delete(requestId);
          resolve(options);
        },
      };

      entry.timeout = setTimeout(() => this.handleProbeTimeout(entry, serverType), PROBE_TIMEOUT_MS);
      this.pendingRequests.set(requestId, entry);

      controllerSocket.emit('acp:probe-options', { requestId, serverType });
    });
  }

  /**
   * 探测超时守卫：登录进行中（注册表命中）时不结算，改为重新挂起（受绝对上限约束），
   * 等 agent-gear 在登录结束后上抛真实探测结果再结算。
   */
  private handleProbeTimeout(entry: ProbeRequest, serverType: string): void {
    const pending = this.registry.pendingFor(entry.controllerId);
    if (pending) {
      const remaining = pending.deadlineMs - Date.now();
      if (remaining > 0) {
        entry.timeout = setTimeout(
          () => this.handleProbeTimeout(entry, serverType),
          Math.min(LOGIN_GUARD_REARM_MS, remaining),
        );
        return;
      }
      this.logger.warn({ controllerId: entry.controllerId, serverType }, 'login guard deadline exceeded, forcing settle');
    } else {
      this.logger.warn({ controllerId: entry.controllerId, serverType }, 'probe timeout');
    }
    entry.resolve(EMPTY_OPTIONS);
  }

  async handleProbeResult(controllerId: string, payload: ProbeResultPayload): Promise<void> {
    const request = this.pendingRequests.get(payload.requestId);
    if (!request) return;

    const redis = getRedisClient();
    const key = cacheKey(controllerId, payload.serverType);

    if (payload.success) {
      const options: AcpServerOptionsData = {
        modes: payload.modes ?? [],
        models: payload.availableModels ?? [],
        currentModeId: payload.currentModeId ?? null,
        currentModelId: payload.currentModelId ?? null,
        probedAt: new Date().toISOString(),
      };
      await redis.set(key, JSON.stringify(options), 'EX', SUCCESS_CACHE_TTL);
      this.logger.info(
        { controllerId, serverType: payload.serverType, modes: options.modes.length, models: options.models.length },
        'probed ACP options',
      );
      request.resolve(options);
    } else {
      this.logger.warn(
        { controllerId, serverType: payload.serverType, error: payload.error ?? 'unknown' },
        'probe failed',
      );
      await redis.set(key, JSON.stringify(EMPTY_OPTIONS), 'EX', FAILURE_CACHE_TTL);
      request.resolve(EMPTY_OPTIONS);
    }
  }

  invalidateCache(controllerId: string, serverType: string): void {
    const redis = getRedisClient();
    redis.del(cacheKey(controllerId, serverType));
  }
}

export const acpOptionsProber = new AcpOptionsProber();
