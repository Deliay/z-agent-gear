import type { Socket } from 'socket.io';
import { getRedisClient } from '../middleware/redis.js';

export interface AcpServerOptionsData {
  modes: Array<{ id: string; name: string; description?: string }>;
  models: Array<{ id: string; name: string; provider?: string }>;
  currentModeId: string | null;
  currentModelId: string | null;
  probedAt: string | null;
}

interface ProbeRequest {
  requestId: string;
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

const SUCCESS_CACHE_TTL = 3600; // 1h
const FAILURE_CACHE_TTL = 60; // 失败结果短缓存：让 agent-api 轮询尽快返回，同时允许快速重试

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
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        console.warn(`[ACP options] Probe timeout for ${controllerId}/${serverType}`);
        resolve(EMPTY_OPTIONS);
      }, 30000);

      this.pendingRequests.set(requestId, {
        requestId,
        resolve: (options) => {
          clearTimeout(timeout);
          this.pendingRequests.delete(requestId);
          resolve(options);
        },
      });

      controllerSocket.emit('acp:probe-options', { requestId, serverType });
    });
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
      console.log(
        `[ACP options] Probed ${controllerId}/${payload.serverType}: ` +
        `modes=${options.modes.length} models=${options.models.length}`,
      );
      request.resolve(options);
    } else {
      console.warn(
        `[ACP options] Probe failed for ${controllerId}/${payload.serverType}: ${payload.error ?? 'unknown'}`,
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
