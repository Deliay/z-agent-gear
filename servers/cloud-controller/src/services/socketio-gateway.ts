import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { ContainerService } from './container-service.js';
import type { HeartbeatTracker } from './heartbeat-tracker.js';
import type { TokenService } from './token-service.js';

export const WORKER_NAMESPACE = '/worker';
export const CURRENT_MAJOR_VERSION = '2';
export const DEFAULT_HANDSHAKE_RATE_WINDOW_MS = 60000;
export const DEFAULT_HANDSHAKE_RATE_MAX = 60;

interface Logger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

interface RegisterPayload {
  key?: string;
  hostname?: string;
  version?: string;
  platform?: string;
  homeDir?: string;
}

export interface HandshakeRateLimitOptions {
  /** 滑动窗口时长（ms），默认 60000。 */
  windowMs?: number;
  /** 单个来源 IP 在窗口内允许的握手次数，默认 60。 */
  max?: number;
}

export interface WorkerGatewayDeps {
  tokenService: TokenService;
  containerService: ContainerService;
  heartbeatTracker: HeartbeatTracker;
  handshakeRateLimit?: HandshakeRateLimitOptions;
  logger?: Logger;
}

/**
 * 轻量滑动窗口速率限制：按 key（来源 IP）统计窗口内握手次数。
 * 仅用于缓解握手阶段 bcrypt 校验带来的 CPU 消耗型攻击。
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  allow(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  reset(): void {
    this.hits.clear();
  }
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

/**
 * Socket.IO `/worker` namespace 接入网关。
 * 握手 middleware 校验一次性 token（含按源 IP 限速）；register 校验 hostname/版本后绑定
 * containerId → online；heartbeat 计时；shutdown 通知；同一 containerId 多连接时仅在
 * 最后一个 socket 断开后才判定离线。
 */
export function registerWorkerGateway(
  io: SocketIOServer,
  deps: WorkerGatewayDeps,
): void {
  const logger = deps.logger ?? console;
  const nsp = io.of(WORKER_NAMESPACE);
  const rateLimiter = new SlidingWindowRateLimiter(
    deps.handshakeRateLimit?.windowMs ?? DEFAULT_HANDSHAKE_RATE_WINDOW_MS,
    deps.handshakeRateLimit?.max ?? DEFAULT_HANDSHAKE_RATE_MAX,
  );
  /** containerId → 当前活跃 socketId 集合（支持重连/多连接）。 */
  const activeSockets = new Map<string, Set<string>>();

  nsp.use((socket: Socket, next) => {
    const sourceIp = socket.handshake.address;
    if (!rateLimiter.allow(sourceIp)) {
      logger.warn?.(`[worker] handshake rate limited from ${sourceIp}`);
      next(new Error('RATE_LIMITED'));
      return;
    }

    // 优先从 Socket.IO 握手 auth 读取一次性 token（问题 11：避免 token 进 URL/access log）；
    // 兼容遗留 query token。
    const token =
      firstString(socket.handshake.auth?.token) ?? firstString(socket.handshake.query?.token);
    void deps.tokenService
      .verify(token)
      .then((container) => {
        if (!container) {
          logger.warn?.(
            `[worker] handshake rejected from ${socket.handshake.address}: INVALID_TOKEN`,
          );
          next(new Error('INVALID_TOKEN'));
          return;
        }
        socket.data.containerId = container.id;
        next();
      })
      .catch((err) => {
        logger.error?.('[worker] handshake error', err);
        next(new Error('INVALID_TOKEN'));
      });
  });

  // 销毁流程：向绑定到 containerId room 的在线容器发送 shutdown。
  deps.containerService.onShutdown((containerId) => {
    nsp.to(containerId).emit('shutdown', { reason: '强制销毁' });
  });

  nsp.on('connection', (socket: Socket) => {
    const containerId = socket.data.containerId as string;
    socket.join(containerId);
    const sockets = activeSockets.get(containerId) ?? new Set<string>();
    sockets.add(socket.id);
    activeSockets.set(containerId, sockets);

    socket.on('register', async (payload: RegisterPayload = {}) => {
      // key 字段被忽略（由握手 token 替代）。
      const major = typeof payload?.version === 'string' ? payload.version.split('.')[0] : undefined;
      if (major !== CURRENT_MAJOR_VERSION) {
        socket.emit('error', {
          code: 'VERSION_MISMATCH',
          message: 'agent-gear 版本不兼容，请升级到 major 2 后重试',
        });
        socket.disconnect(true);
        return;
      }

      // 契约 §2.2：hostname 为必填字段。
      const hostname = typeof payload?.hostname === 'string' ? payload.hostname.trim() : '';
      if (!hostname) {
        socket.emit('error', {
          code: 'INVALID_PAYLOAD',
          message: '缺少必填字段 hostname',
        });
        socket.disconnect(true);
        return;
      }

      try {
        socket.data.registered = true;
        socket.data.hostname = hostname;
        deps.heartbeatTracker.record(containerId);
        await deps.containerService.markOnline(containerId);
        socket.emit('registered', { controllerId: containerId });
      } catch (err) {
        logger.error?.('[worker] register error', err);
        socket.emit('error', { code: 'REGISTER_FAILED', message: '注册失败' });
        socket.disconnect(true);
      }
    });

    socket.on('heartbeat', () => {
      if (!socket.data.registered) return;
      deps.heartbeatTracker.record(containerId);
    });

    socket.on('unregister', () => {
      socket.emit('unregistered', {});
      socket.disconnect(true);
    });

    socket.on('disconnect', () => {
      const set = activeSockets.get(containerId);
      set?.delete(socket.id);
      const remaining = set?.size ?? 0;
      // 同一 containerId 仍有活跃 socket（多连接/重连窗口）时不判定离线。
      if (remaining > 0) return;
      activeSockets.delete(containerId);

      deps.heartbeatTracker.remove(containerId);
      if (!socket.data.registered) return;
      void deps.containerService
        .getById(containerId)
        .then((record) => {
          if (record && record.status === 'online') {
            return deps.containerService.markConnecting(containerId);
          }
          return undefined;
        })
        .catch((err) => {
          logger.error?.('[worker] disconnect handling error', err);
        });
    });
  });
}
