import type { Server as SocketIOServer, Socket } from 'socket.io';
import { runWithLogContext } from '../observability/log-context.js';
import { type ObservationLogger } from '../observability/logger.js';
import { injectTraceparent, withSpan } from '../observability/trace.js';
import type { ContainerService } from './container-service.js';
import type { HeartbeatTracker } from './heartbeat-tracker.js';
import type { TokenService } from './token-service.js';
import type { WorkloadDispatcher } from './workload-dispatcher.js';
import {
  MIN_HARNESS_WORKER_VERSION,
  MIN_WORKER_VERSION,
  SUPPORTED_MAJOR,
  isSupportedWorkerVersion,
  sanitizeVersionForLog,
} from './worker-version.js';

export const WORKER_NAMESPACE = '/worker';

/**
 * Socket.IO 引擎（engine.io）握手/升级的 HTTP 路径，固定为引擎默认 `/socket.io/`。
 *
 * 注意：`/worker` 是 Socket.IO **namespace**（存在于协议握手内），不是 URL 路径。
 * 反向代理 / Ingress 必须放行本 engine path，否则握手请求打到 `/socket.io/?EIO=4...`
 * 会被入口层 404（问题 46）。客户端与服务端必须使用同一 engine path。
 */
export const ENGINE_PATH = '/socket.io/';

export const DEFAULT_HANDSHAKE_RATE_WINDOW_MS = 60000;
/** 单个 token/container 在窗口内允许的握手次数（问题 59：按容器维度，避免共享 Ingress IP 全局限流）。 */
export const DEFAULT_HANDSHAKE_RATE_MAX = 60;
/** 单个来源 IP 的窗口内握手上限（兜底，高于 per-container 上限）。 */
export const DEFAULT_HANDSHAKE_RATE_IP_MAX = 600;
/** 限速 Map 内存中保留的最大 key 数（问题 60：与 admin-api LoginRateLimiter 同款有界基线）。 */
export const DEFAULT_HANDSHAKE_RATE_MAX_ENTRIES = 10_000;
/** containerId 前缀允许的形状（问题 60：限速键由未认证对端任意铸造，须先校验形状/长度）。 */
export const CONTAINER_ID_PREFIX_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

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
  /** 限速 Map 保留的最大 key 数（问题 60），默认 10000。 */
  maxEntries?: number;
}

export interface WorkerGatewayDeps {
  tokenService: TokenService;
  containerService: ContainerService;
  heartbeatTracker: HeartbeatTracker;
  handshakeRateLimit?: HandshakeRateLimitOptions;
  /** 工作负载编排器（缺省时退化为既有行为：register → online）。 */
  workloadDispatcher?: WorkloadDispatcher;
  /** 结构化日志（pino 调用面，必填注入；contracts/observability.md §2）。 */
  logger: ObservationLogger;
}

/** 网关对外暴露的桥接句柄：供 dispatcher 注入 emitToContainer/isConnected（避免循环依赖）。 */
export interface WorkerGatewayHandle {
  emitToContainer: (containerId: string, event: string, payload: unknown) => void;
  isConnected: (containerId: string) => boolean;
}

/**
 * 轻量滑动窗口速率限制：按 key 统计窗口内握手次数。
 * 仅用于缓解握手阶段 bcrypt 校验带来的 CPU 消耗型攻击。
 *
 * 问题 60（有界性，与 admin-api LoginRateLimiter 同款基线）：限速键可被未认证对端任意铸造，
 * 因此必须 `maxEntries` 有界——新增 key 超上限时**过期优先、次选最旧**驱逐一条，
 * 保证随机 key 洪水下 Map 不会无界增长。
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
    private readonly maxEntries: number = DEFAULT_HANDSHAKE_RATE_MAX_ENTRIES,
  ) {}

  /** 当前保留的 key 数（单测断言有界性用）。 */
  get size(): number {
    return this.hits.size;
  }

  allow(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    let recent = this.hits.get(key);
    if (recent) {
      recent = recent.filter((t) => t > cutoff);
    } else {
      // 新 key：先做有界驱逐，再落条目（问题 60）
      if (this.hits.size >= this.maxEntries) {
        this.evict(now, cutoff);
      }
      recent = [];
    }

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

  /** 过期优先（窗口内无命中），次选最旧（插入序首个）。 */
  private evict(now: number, cutoff: number): void {
    for (const [key, times] of this.hits) {
      const last = times.length > 0 ? times[times.length - 1]! : 0;
      if (last <= cutoff) {
        this.hits.delete(key);
        return;
      }
    }
    const oldest = this.hits.keys().next().value;
    if (oldest !== undefined) this.hits.delete(oldest);
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
 * 服务端下发报文统一注入顶层 `_meta`（契约 cloud-controller-websocket.md 附录 B）：
 * payload 为普通对象时 `{ ...payload, _meta: { ...(已有 _meta 对象), ...injectTraceparent({}) } }`；
 * 无活跃 span 时 `_meta` 为空对象（不注入无效 traceparent）。非普通对象原样返回。
 * 旧 worker 忽略未知字段，既有 payload 字段不受影响。
 */
function withTraceMeta<T>(payload: T): T {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  const existing = record._meta;
  const meta =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return { ...record, _meta: { ...meta, ...injectTraceparent({}) } } as T;
}

/**
 * 从原始 token 字符串（`<containerId>.<secret>`）解析 containerId 前缀，**不运行 bcrypt**。
 * 用作限速键；token 缺失 / 分隔符位置非法 / 前缀不符合 `CONTAINER_ID_PREFIX_PATTERN` 时返回
 * undefined，调用方回退到 peer IP（问题 60：避免未认证对端用任意字符串铸造限速键）。
 */
export function containerIdFromToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const separator = token.indexOf('.');
  if (separator <= 0) return undefined;
  const prefix = token.slice(0, separator);
  if (!CONTAINER_ID_PREFIX_PATTERN.test(prefix)) return undefined;
  return prefix;
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
): WorkerGatewayHandle {
  const logger = deps.logger;
  const nsp = io.of(WORKER_NAMESPACE);
  const windowMs = deps.handshakeRateLimit?.windowMs ?? DEFAULT_HANDSHAKE_RATE_WINDOW_MS;
  // 主桶按 containerId（token 前缀）计数，回退 peer IP；IP 桶为更高上限的兜底。
  const keyLimiter = new SlidingWindowRateLimiter(
    windowMs,
    deps.handshakeRateLimit?.max ?? DEFAULT_HANDSHAKE_RATE_MAX,
    deps.handshakeRateLimit?.maxEntries ?? DEFAULT_HANDSHAKE_RATE_MAX_ENTRIES,
  );
  const ipLimiter = new SlidingWindowRateLimiter(
    windowMs,
    deps.handshakeRateLimit?.ipMax ?? DEFAULT_HANDSHAKE_RATE_IP_MAX,
    deps.handshakeRateLimit?.maxEntries ?? DEFAULT_HANDSHAKE_RATE_MAX_ENTRIES,
  );
  /** containerId → 当前活跃 socketId 集合（支持重连/多连接）。 */
  const activeSockets = new Map<string, Set<string>>();

  /** 下发事件到 containerId 房间：统一注入顶层 `_meta.traceparent`（T-OBS13）。 */
  const emitToContainer = (containerId: string, event: string, payload: unknown): void => {
    nsp.to(containerId).emit(event, withTraceMeta(payload));
  };
  const isConnected = (containerId: string): boolean => (activeSockets.get(containerId)?.size ?? 0) > 0;

  nsp.use((socket: Socket, next) => {
    // 问题 59：部署形态下 worker 经 nginx Ingress 回连，TCP 对端是所有 worker 共享的
    // Ingress 控制器 IP。故主限速键取一次性 token 的 containerId 前缀（无需 bcrypt），
    // 仅当无 token 时回退 peer IP；另保留一个更高上限的 per-IP 桶作为兜底。
    const token = handshakeToken(socket);
    const sourceIp = socket.handshake.address;
    const containerId = containerIdFromToken(token);
    const key = containerId ? `container:${containerId}` : `ip:${sourceIp}`;
    // T-OBS13：握手链路传播——客户端可在握手 auth 携带 W3C traceparent（非法/缺失自动忽略）。
    const traceparent = firstString(socket.handshake.auth?.traceparent);
    void withSpan(
      'socket.handshake',
      {
        socketId: socket.id,
        namespace: nsp.name,
        transport: socket.conn.transport.name,
        from: sourceIp,
        tokenPresent: Boolean(token),
      },
      async () => {
        logger.info(
          {
            event: 'handshake_attempt',
            socketId: socket.id,
            namespace: nsp.name,
            transport: socket.conn.transport.name,
            from: sourceIp,
            tokenPresent: Boolean(token),
          },
          'handshake attempt',
        );
        // 问题 60：先判 per-IP 兜底桶（其键空间亦为有界），IP 超限时直接拒绝，
        // 不再调用 keyLimiter（避免被拒请求为未认证对端铸造新的 key 条目）。
        if (!ipLimiter.allow(`ip:${sourceIp}`) || !keyLimiter.allow(key)) {
          logger.warn(
            { event: 'handshake_rate_limited', key, from: sourceIp },
            'handshake rate limited',
          );
          next(new Error('RATE_LIMITED'));
          return;
        }

        // 一次性 token 优先取自握手 auth（问题 11：token 不放入 URL/access log），兼容遗留 query。
        try {
          const container = await deps.tokenService.verify(token);
          if (!container) {
            logger.warn(
              {
                event: 'handshake_rejected',
                socketId: socket.id,
                from: socket.handshake.address,
                reason: 'INVALID_TOKEN',
                tokenPresent: Boolean(token),
              },
              'handshake rejected',
            );
            next(new Error('INVALID_TOKEN'));
            return;
          }
          logger.info(
            {
              event: 'handshake_accepted',
              socketId: socket.id,
              containerId: container.id,
              from: sourceIp,
            },
            'handshake accepted',
          );
          socket.data.containerId = container.id;
          next();
        } catch (err) {
          logger.error({ err }, 'handshake error');
          next(new Error('INVALID_TOKEN'));
        }
      },
      { parent: traceparent },
    );
  });

  // 销毁流程：先下发并等待 post 脚本批次（若有），再向绑定到 containerId room 的在线容器发送 shutdown。
  deps.containerService.onShutdown(async (containerId, reason) => {
    if (deps.workloadDispatcher) {
      await deps.workloadDispatcher.runPostBatch(containerId);
    }
    emitToContainer(containerId, 'shutdown', { reason: reason ?? '强制销毁' });
  });

  nsp.on('connection', (socket: Socket) => {
    const containerId = socket.data.containerId as string;
    socket.join(containerId);
    const sockets = activeSockets.get(containerId) ?? new Set<string>();
    sockets.add(socket.id);
    activeSockets.set(containerId, sockets);
    logger.info(
      {
        event: 'connected',
        socketId: socket.id,
        containerId,
        transport: socket.conn.transport.name,
        from: socket.handshake.address,
      },
      'connected',
    );

    socket.on('register', async (payload: RegisterPayload = {}) => {
      // 事件回调不跨 AsyncLocalStorage 自动延续，入口显式建立 containerId 日志上下文（T-OBS13）。
      await runWithLogContext({ containerId }, async () => {
        // key 字段被忽略（由握手 token 替代）。
        // 版本门禁必须先于全部注册副作用（心跳计时 / 初始化查询下发 / online / connectedAt）：
        // 先读取容器 purpose，再按 purpose 选择门禁（harness 逐容器 agentGearMinVersion，恒 ≥2.12.0 / 普通 2.2.0，契约 §3.4）。
        // 读取本身只读、无副作用；历史记录缺少 purpose 时按 idle 处理。
        // 读取失败（DB 抖动）按注册失败处理，避免 async handler 产生未捕获 rejection。
        let record: Awaited<ReturnType<ContainerService['getById']>>;
        try {
          record = await deps.containerService.getById(containerId);
        } catch (err) {
          logger.error({ err }, 'register purpose lookup error');
          socket.emit('error', withTraceMeta({ code: 'REGISTER_FAILED', message: '注册失败' }));
          socket.disconnect(true);
          return;
        }
        const purpose = record?.purpose ?? 'idle';
        const isHarness = purpose === 'harness';
        // C-4：harness 使用落库的 max(常量, 请求值)；历史记录缺省回退常量。
        const minimumVersion = isHarness
          ? (record?.agentGearMinVersion ?? MIN_HARNESS_WORKER_VERSION)
          : MIN_WORKER_VERSION;
        const versionSupport = isSupportedWorkerVersion(payload?.version, minimumVersion);
        if (!versionSupport.supported) {
          const currentVersion = sanitizeVersionForLog(payload?.version);
          logger.warn(
            {
              event: 'register_rejected',
              socketId: socket.id,
              containerId,
              reason: 'VERSION_MISMATCH',
              purpose,
              currentVersion,
              minimumVersion,
              supportedMajor: SUPPORTED_MAJOR,
              versionReason: versionSupport.reason,
            },
            'register rejected',
          );
          socket.emit('error', withTraceMeta({
            code: 'VERSION_MISMATCH',
            message:
              `agent-gear 版本不兼容，当前版本 ${currentVersion}，最低版本 ${minimumVersion}` +
              `（supported major: ${SUPPORTED_MAJOR}）`,
            currentVersion,
            minimumVersion,
            supportedMajor: SUPPORTED_MAJOR,
          }));
          socket.disconnect(true);
          return;
        }

        // 契约 §2.2：hostname 为必填字段。
        const hostname = typeof payload?.hostname === 'string' ? payload.hostname.trim() : '';
        if (!hostname) {
          logger.warn(
            {
              event: 'register_rejected',
              socketId: socket.id,
              containerId,
              reason: 'INVALID_PAYLOAD',
              missingField: 'hostname',
            },
            'register rejected',
          );
          socket.emit('error', withTraceMeta({
            code: 'INVALID_PAYLOAD',
            message: '缺少必填字段 hostname',
          }));
          socket.disconnect(true);
          return;
        }

        try {
          socket.data.registered = true;
          socket.data.hostname = hostname;
          deps.heartbeatTracker.record(containerId);

          // 有初始化脚本 → 先回 registered，再由 dispatcher 下发 workload:run（契约 §3 生命周期）；
          // 无初始化脚本 → 维持现状（register 接受即 online）。
          const willInitialize = deps.workloadDispatcher
            ? await deps.workloadDispatcher.hasInitScripts(containerId)
            : false;
          if (!willInitialize) {
            await deps.containerService.markOnline(containerId);
          }
          socket.emit('registered', withTraceMeta({ controllerId: containerId, initializing: willInitialize }));
          if (willInitialize && deps.workloadDispatcher) {
            const result = await deps.workloadDispatcher.startInit(containerId);
            // 仅有占位/已删除项时 startInit 返回 initializing=false：仍须按现状上线。
            // 必须失败（requiredFailure）时容器已被强制注销，**不得** markOnline（裁决 10）。
            // harness 环境缺失（failed）时容器已判 failed，同样不得 online（T-CC13）。
            if (!result.initializing && !result.requiredFailure && !result.failed) {
              await deps.containerService.markOnline(containerId);
            }
          }

          logger.info(
            {
              event: 'registered',
              socketId: socket.id,
              containerId,
              hostname,
              version: payload?.version ?? 'unknown',
              platform: payload?.platform ?? 'unknown',
              initializing: willInitialize,
            },
            'registered',
          );
        } catch (err) {
          logger.error({ err }, 'register error');
          socket.emit('error', withTraceMeta({ code: 'REGISTER_FAILED', message: '注册失败' }));
          socket.disconnect(true);
        }
      });
    });

    socket.on('heartbeat', () => {
      runWithLogContext({ containerId }, () => {
        if (!socket.data.registered) return;
        deps.heartbeatTracker.record(containerId);
      });
    });

    socket.on('workload:result', (payload: unknown) => {
      runWithLogContext({ containerId }, () => {
        if (!socket.data.registered || !deps.workloadDispatcher) return;
        void deps.workloadDispatcher
          .handleResult(containerId, payload as Record<string, unknown>)
          .catch((err) => {
            logger.error({ err }, 'workload:result handling error');
          });
      });
    });

    socket.on('unregister', () => {
      runWithLogContext({ containerId }, () => {
        socket.emit('unregistered', withTraceMeta({}));
        socket.disconnect(true);
      });
    });

    socket.on('disconnect', (reason: string) => {
      runWithLogContext({ containerId }, () => {
        const set = activeSockets.get(containerId);
        set?.delete(socket.id);
        const remaining = set?.size ?? 0;
        logger.info(
          {
            event: 'disconnected',
            socketId: socket.id,
            containerId,
            reason,
            registered: socket.data.registered === true,
            remainingSockets: remaining,
          },
          'disconnected',
        );
        // 同一 containerId 仍有活跃 socket（多连接/重连窗口）时不判定离线。
        if (remaining > 0) return;
        activeSockets.delete(containerId);

        deps.heartbeatTracker.remove(containerId);
        if (!socket.data.registered) return;
        void deps.containerService
          .getById(containerId)
          .then((record) => {
            // initializing 期间掉线保持状态等待重连（不退回 connecting，由看门狗收口）。
            if (record && record.status === 'online') {
              return deps.containerService.markConnecting(containerId);
            }
            return undefined;
          })
          .catch((err) => {
            logger.error({ err }, 'disconnect handling error');
          });
      });
    });
  });

  return { emitToContainer, isConnected };
}
