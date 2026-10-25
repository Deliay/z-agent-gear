import { Server as SocketIOServer, Socket } from 'socket.io';
import { getRedisClient } from '../middleware/redis.js';
import { harnessLoginRegistry, type HarnessLoginRegistry } from './harness-login-registry.js';

/** 上行 `harness:login:required`（controller payload 不可信，逐字段校验）。 */
export interface HarnessLoginRequiredData {
  requestId: string;
  serverType: string;
  trigger: string;
  url: string;
  userCode: string;
  expiresInSeconds?: number;
  account?: string;
}

export interface HarnessLoginSucceededData {
  requestId: string;
  account?: string;
}

export type HarnessLoginFailedReason = 'cancelled' | 'timeout' | 'error';

export interface HarnessLoginFailedData {
  requestId: string;
  reason: HarnessLoginFailedReason;
  error?: string;
}

export interface HarnessLoginCancelData {
  requestId: string;
}

interface PendingLogin {
  requestId: string;
  socketId: string;
  controllerId: string;
  userId: string;
  serverType: string;
  deadlineMs: number;
}

const REQUIRED_CHANNEL = 'harness:login:required';
const RESOLVED_CHANNEL = 'harness:login:resolved';
const CANCEL_CHANNEL = 'harness:login:cancel';

const KIMI_SERVER_TYPE = 'kimi_code';
const TRIGGERS = new Set(['probe-options', 'acp:start', 'acp:resume']);
const FAILED_REASONS = new Set<HarnessLoginFailedReason>(['cancelled', 'timeout', 'error']);

const REQUEST_ID_MAX_LENGTH = 200;
const URL_MAX_LENGTH = 2048;
const USER_CODE_MAX_LENGTH = 64;
const ACCOUNT_MAX_LENGTH = 200;
const ERROR_MAX_LENGTH = 200;

const EXPIRES_MIN_SECONDS = 60;
const EXPIRES_MAX_SECONDS = 3600;
const EXPIRES_DEFAULT_SECONDS = 1800;

/** 登录等待上限（与设备码有效期一致 30 分钟），env `KIMI_LOGIN_WAIT_MS` 可覆盖。 */
export function resolveLoginWaitMs(): number {
  const raw = Number(process.env.KIMI_LOGIN_WAIT_MS);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 1_800_000;
}

/** 绝对上限兜底：登录等待上限 + 60s，防注册表泄漏导致探测/启动永久挂起。 */
const LOGIN_DEADLINE_GRACE_MS = 60_000;

export interface HarnessLoginManagerOptions {
  registry?: HarnessLoginRegistry;
  loginWaitMs?: number;
  now?: () => number;
}

/**
 * harness 登录事件透传：
 * 入站校验（controller payload 不可信）→ Redis publish（归属由 socket.data 注入）
 * → 进程内注册表（供 30s 超时守卫查询）→ 订阅 `harness:login:cancel` 定向下发
 * → socket 断开收敛（发布 failed + 清注册表）。
 */
export class HarnessLoginManager {
  private pendingRequests = new Map<string, PendingLogin>();
  private io: SocketIOServer | null = null;
  private subscriber: ReturnType<typeof getRedisClient> | null = null;
  private readonly registry: HarnessLoginRegistry;
  private readonly loginWaitMs: number;
  private readonly now: () => number;

  constructor(options: HarnessLoginManagerOptions = {}) {
    this.registry = options.registry ?? harnessLoginRegistry;
    this.loginWaitMs = options.loginWaitMs ?? resolveLoginWaitMs();
    this.now = options.now ?? Date.now;
  }

  start(io: SocketIOServer): void {
    this.io = io;
    this.subscribeToCancels();
  }

  private subscribeToCancels(): void {
    const redis = getRedisClient();
    this.subscriber = redis.duplicate();

    this.subscriber.subscribe(CANCEL_CHANNEL, (err) => {
      if (err) {
        console.error('Failed to subscribe to harness login cancel channel:', err);
      }
    });

    this.subscriber.on('message', (channel: string, message: string) => {
      if (channel !== CANCEL_CHANNEL) return;
      try {
        this.handleCancel(JSON.parse(message) as HarnessLoginCancelData);
      } catch (err) {
        console.error('Error handling harness login cancel:', err);
      }
    });
  }

  async handleLoginRequired(socket: Socket, data: HarnessLoginRequiredData): Promise<void> {
    if (!data || typeof data !== 'object') {
      console.warn('[HarnessLogin] dropped required event with invalid payload');
      return;
    }

    const { requestId, serverType, trigger, url, userCode } = data;
    const expiresInSeconds = data.expiresInSeconds == null ? EXPIRES_DEFAULT_SECONDS : data.expiresInSeconds;
    const validExpires = Number.isInteger(expiresInSeconds)
      && (expiresInSeconds as number) >= EXPIRES_MIN_SECONDS
      && (expiresInSeconds as number) <= EXPIRES_MAX_SECONDS;
    const validAccount = data.account == null
      || (typeof data.account === 'string' && data.account.length <= ACCOUNT_MAX_LENGTH);

    if (
      typeof requestId !== 'string' || requestId.length === 0 || requestId.length > REQUEST_ID_MAX_LENGTH
      || serverType !== KIMI_SERVER_TYPE
      || typeof trigger !== 'string' || !TRIGGERS.has(trigger)
      || typeof url !== 'string' || url.length === 0 || url.length > URL_MAX_LENGTH || !/^https?:\/\//i.test(url)
      || typeof userCode !== 'string' || userCode.length === 0 || userCode.length > USER_CODE_MAX_LENGTH
      || !validExpires || !validAccount
    ) {
      console.warn(
        '[HarnessLogin] dropped invalid required event: requestId=%j serverType=%j trigger=%j urlLength=%d',
        requestId, serverType, trigger, typeof url === 'string' ? url.length : -1,
      );
      return;
    }

    const controllerId = socket.data.controllerId;
    const userId = socket.data.userId;
    if (typeof controllerId !== 'string' || controllerId.length === 0
      || typeof userId !== 'string' || userId.length === 0) {
      console.warn('[HarnessLogin] dropped required event without socket identity');
      return;
    }

    // 同一 controller 已有一条进行中登录：agent-gear single-flight 下不应出现，
    // 防御旧版/异常（不重复建待办、不重复推送）。
    const existing = this.registry.pendingFor(controllerId);
    if (existing) {
      if (existing.requestId !== requestId) {
        console.warn(
          '[HarnessLogin] ignored duplicated required for controller %s (pending=%s incoming=%s)',
          controllerId, existing.requestId, requestId,
        );
      }
      return;
    }

    const deadlineMs = this.now() + this.loginWaitMs + LOGIN_DEADLINE_GRACE_MS;
    this.pendingRequests.set(requestId, {
      requestId,
      socketId: socket.id,
      controllerId,
      userId,
      serverType,
      deadlineMs,
    });
    this.registry.mark(controllerId, requestId, deadlineMs);

    const redis = getRedisClient();
    await redis.publish(REQUIRED_CHANNEL, JSON.stringify({
      requestId,
      controllerId,
      userId,
      serverType,
      trigger,
      url,
      userCode,
      expiresInSeconds,
      receivedAt: new Date(this.now()).toISOString(),
    }));
  }

  async handleLoginSucceeded(socket: Socket, data: HarnessLoginSucceededData): Promise<void> {
    const requestId = typeof data?.requestId === 'string' ? data.requestId : '';
    const account = typeof data?.account === 'string' ? data.account.slice(0, ACCOUNT_MAX_LENGTH) : undefined;
    const pending = this.takePending(socket, requestId, 'succeeded');
    if (!pending) return;

    // 探测失败会写 60s 空结果缓存，不失效会导致「登录后仍拿不到模型」。
    const redis = getRedisClient();
    const key = `acp:options:${pending.controllerId}:${KIMI_SERVER_TYPE}`;
    await redis.del(key);

    await redis.publish(RESOLVED_CHANNEL, JSON.stringify({
      requestId: pending.requestId,
      controllerId: pending.controllerId,
      userId: pending.userId,
      result: 'succeeded',
      ...(account ? { account } : {}),
    }));
  }

  async handleLoginFailed(socket: Socket, data: HarnessLoginFailedData): Promise<void> {
    const requestId = typeof data?.requestId === 'string' ? data.requestId : '';
    const reason = data?.reason;
    if (!FAILED_REASONS.has(reason)) {
      console.warn('[HarnessLogin] dropped failed event with unknown reason=%j', reason);
      return;
    }

    const pending = this.takePending(socket, requestId, 'failed');
    if (!pending) return;

    const error = typeof data.error === 'string' ? data.error.slice(0, ERROR_MAX_LENGTH) : undefined;
    const result = reason === 'cancelled' ? 'cancelled' : reason === 'timeout' ? 'expired' : 'failed';

    await getRedisClient().publish(RESOLVED_CHANNEL, JSON.stringify({
      requestId: pending.requestId,
      controllerId: pending.controllerId,
      userId: pending.userId,
      result,
      ...(error ? { error } : {}),
    }));
  }

  /** 从 pending/注册表移除并返回；归属不符或未命中时告警并返回 null。 */
  private takePending(socket: Socket, requestId: string, phase: string): PendingLogin | null {
    const pending = requestId ? this.pendingRequests.get(requestId) : undefined;
    if (!pending) {
      console.warn(`[HarnessLogin] dropped ${phase} event for unknown requestId=%j`, requestId);
      return null;
    }
    this.pendingRequests.delete(pending.requestId);
    this.registry.clear(pending.controllerId);
    if (pending.socketId !== socket.id) {
      console.warn(
        '[HarnessLogin] %s event from non-owner socket (expected=%s actual=%s)',
        phase, pending.socketId, socket.id,
      );
      return null;
    }
    return pending;
  }

  /** `harness:login:cancel`（agent-api → controller-api）：按 requestId 定向 emit 到发起 socket。 */
  handleCancel(data: HarnessLoginCancelData): void {
    const requestId = typeof data?.requestId === 'string' ? data.requestId : '';
    const pending = requestId ? this.pendingRequests.get(requestId) : undefined;
    if (!pending) {
      console.warn('[HarnessLogin] cancel for unknown requestId=%j (dropped)', requestId);
      return;
    }

    const socket = this.io?.sockets.sockets.get(pending.socketId);
    if (!socket) {
      console.warn('[HarnessLogin] cancel target socket %s not connected (dropped)', pending.socketId);
      return;
    }
    socket.emit(CANCEL_CHANNEL, { requestId: pending.requestId });
  }

  /** controller 断线收敛：发布 resolved(failed) 并清注册表，挂起动作由超时守卫的绝对上限结算。 */
  clearForSocket(socketId: string): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.socketId !== socketId) continue;
      this.pendingRequests.delete(requestId);
      this.registry.clear(pending.controllerId);
      void Promise.resolve()
        .then(() => getRedisClient().publish(RESOLVED_CHANNEL, JSON.stringify({
          requestId: pending.requestId,
          controllerId: pending.controllerId,
          userId: pending.userId,
          result: 'failed',
          error: 'controller disconnected',
        })))
        .catch((err: unknown) => {
          console.error('Failed to publish harness login resolved (disconnect):', err);
        });
    }
  }

  getPendingCount(): number {
    return this.pendingRequests.size;
  }

  stop(): void {
    if (this.subscriber) {
      this.subscriber.disconnect();
      this.subscriber = null;
    }
    this.pendingRequests.clear();
  }
}

export const harnessLoginManager = new HarnessLoginManager();
