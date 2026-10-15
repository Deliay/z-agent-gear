import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { ContainerService } from './container-service.js';
import type { HeartbeatTracker } from './heartbeat-tracker.js';
import type { TokenService } from './token-service.js';

export const WORKER_NAMESPACE = '/worker';

/**
 * Socket.IO 引擎（engine.io）握手/升级的 HTTP 路径，固定为引擎默认 `/socket.io/`。
 *
 * 注意：`/worker` 是 Socket.IO **namespace**（存在于协议握手内），不是 URL 路径。
 * 反向代理 / Ingress 必须放行本 engine path，否则握手请求打到 `/socket.io/?EIO=4...`
 * 会被入口层 404（问题 46）。客户端与服务端必须使用同一 engine path。
 */
export const ENGINE_PATH = '/socket.io/';

export const CURRENT_MAJOR_VERSION = '2';
export const DEFAULT_HANDSHAKE_RATE_WINDOW_MS = 60000;
/** 单个 token/container 在窗口内允许的握手次数（问题 59：按容器维度，避免共享 Ingress IP 全局限流）。 */
export const DEFAULT_HANDSHAKE_RATE_MAX = 60;
/** 单个来源 IP 的窗口内握手上限（兜底，高于 per-container 上限）。 */
export const DEFAULT_HANDSHAKE_RATE_IP_MAX = 600;

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
  /** 单个 token/container 在窗口内允许的握手次数，默认 60。 */
  max?: number;
  /** 单个来源 IP 在窗口内允许的握手次数（兜底），默认 600。 */
  ipMax?: number;
}

export interface WorkerGatewayDeps {
  tokenService: TokenService;
  containerService: ContainerService;
  heartbeatTracker: HeartbeatTracker;
  handshakeRateLimit?: HandshakeRateLimitOptions;
  logger?: Logger;
}

/**
 * 轻量滑动窗口速率限制：按 key 统计窗口内握手次数。
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

/** 从握手读取一次性 token（auth 优先，兼容遗留 query）。 */
function handshakeToken(socket: Socket): string | undefined {
  return (
    firstString(socket.handshake.auth?.token) ?? firstString(socket.handshake.query?.token)
  );
}

/**
 * 从原始 token 字符串（`<containerId>.<secret>`）解析 containerId 前缀，**不运行 bcrypt**。
 * 用作限速键；token 缺失/格式非法时返回 undefined，调用方回退到 peer IP。
 */
function containerIdFromToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const separator = token.indexOf('.');
  if (separator <= 0) return undefined;
  return token.slice(0, separator);
}

/**
 * Socket.IO `/worker` namespace 接入网关。
 * 握手 middleware 校验一次性 token（含按 containerId 前缀 / 回退源 IP 的限速）；register 校验 hostname/版本后绑定
 * containerId → online；heartbeat 计时；shutdown 通知；同一 containerId 多连接时仅在
 * 最后一个 socket 断开后才判定离线。
 */
export function registerWorkerGateway(
  io: SocketIOServer,
  deps: WorkerGatewayDeps,
): void {
  const logger = deps.logger ?? console;
  const nsp = io.of(WORKER_NAMESPACE);
  const windowMs = deps.handshakeRateLimit?.windowMs ?? DEFAULT_HANDSHAKE_RATE_WINDOW_MS;
  // 主桶按 containerId（token 前缀）计数，回退 peer IP；IP 桶为更高上限的兜底。
  const keyLimiter = new SlidingWindowRateLimiter(
    windowMs,
    deps.handshakeRateLimit?.max ?? DEFAULT_HANDSHAKE_RATE_MAX,
  );
  const ipLimiter = new SlidingWindowRateLimiter(
    windowMs,
    deps.handshakeRateLimit?.ipMax ?? DEFAULT_HANDSHAKE_RATE_IP_MAX,
  );
  /** containerId → 当前活跃 socketId 集合（支持重连/多连接）。 */
  const activeSockets = new Map<string, Set<string>>();

  nsp.use((socket: Socket, next) => {
    // 问题 59：部署形态下 worker 经 nginx Ingress 回连，TCP 对端是所有 worker 共享的
    // Ingress 控制器 IP。故主限速键取一次性 token 的 containerId 前缀（无需 bcrypt），
    // 仅当无 token 时回退 peer IP；另保留一个更高上限的 per-IP 桶作为兜底。
    const token = handshakeToken(socket);
    const sourceIp = socket.handshake.address;
    const containerId = containerIdFromToken(token);
    const key = containerId ? `container:${containerId}` : `ip:${sourceIp}`;
    if (!keyLimiter.allow(key) || !ipLimiter.allow(`ip:${sourceIp}`)) {
      logger.warn?.(`[worker] handshake rate limited key=${key} from ${sourceIp}`);
      next(new Error('RATE_LIMITED'));
      return;
    }

    // 一次性 token 优先取自握手 auth（问题 11：token 不放入 URL/access log），兼容遗留 query。
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
