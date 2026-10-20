import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import type { Socket } from 'socket.io-client';
import {
  connectToServer,
  parseEndpoint,
  type ConnectToServerOptions,
} from '../socketio-client.js';

/** 未设置 `HARNESS_INIT_WAIT_MS` 时的初始化等待上限（10 分钟）。 */
export const DEFAULT_HARNESS_INIT_WAIT_MS = 600_000;

/** 未设置 `ZAG_DEFAULT_WORKSPACE` 时的默认工作区（容器内以 root 运行）。 */
export const DEFAULT_WORKSPACE = '/root/workspace';

/** 云电脑模式必需的环境变量（三者同时非空才进入 supervisor）。 */
export const CLOUD_HOST_MODE_KEYS = ['ZAG_HOST_ENDPOINT', 'ZAG_HOST_KEY', 'ZAG_CONTROLLER_KEY'] as const;

/** 云电脑 supervisor 的运行参数（从容器 env 读取）。 */
export interface CloudHostEnv {
  /** controller-api 标准连接地址（env `ZAG_HOST_ENDPOINT`）。 */
  hostEndpoint: string;
  /** 标准连接凭据（env `ZAG_HOST_KEY`，仅经握手 auth.token 携带）。 */
  hostKey: string;
  /** cloud-controller `/worker` 一次性 token（env `ZAG_CONTROLLER_KEY`）。 */
  controllerKey: string;
  /** cloud-controller `/worker` 地址（env `ZAG_SERVER_ENDPOINT`）。 */
  serverEndpoint: string;
  /** 注册上报的主机名（env `ZAG_HOST_NAME`，缺省 `os.hostname()`）。 */
  hostName: string;
  /** 默认工作区（env `ZAG_DEFAULT_WORKSPACE`，缺省 `/root/workspace`）。 */
  workspace: string;
  /** 初始化等待超时（env `HARNESS_INIT_WAIT_MS`，缺省 10 分钟）。 */
  initWaitMs: number;
}

/** 云电脑 env 校验失败（消息只含变量名，不含任何值）。 */
export class CloudHostEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudHostEnvError';
  }
}

function nonEmpty(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 模式检测：同时设置 `ZAG_HOST_ENDPOINT` + `ZAG_HOST_KEY` + `ZAG_CONTROLLER_KEY` 且非空
 * → 云电脑模式；否则沿用本地控制器单连接旧路径。
 */
export function isCloudHostMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return CLOUD_HOST_MODE_KEYS.every((key) => nonEmpty(env[key]).length > 0);
}

/** 解析初始化等待超时：显式非正整数时回退默认值（不因错误配置阻塞上线）。 */
export function parseInitWaitMs(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HARNESS_INIT_WAIT_MS;
}

/**
 * 读取并校验云电脑模式 env。
 *
 * 缺失项一次性列出变量名（便于 init 日志定位），**绝不输出变量值**（含 secret）。
 */
export function readCloudHostEnv(env: NodeJS.ProcessEnv = process.env): CloudHostEnv {
  const required = [
    'ZAG_HOST_ENDPOINT',
    'ZAG_HOST_KEY',
    'ZAG_CONTROLLER_KEY',
    'ZAG_SERVER_ENDPOINT',
  ] as const;
  const missing = required.filter((key) => nonEmpty(env[key]).length === 0);
  if (missing.length > 0) {
    throw new CloudHostEnvError(
      `missing required environment variable(s) for cloud-host mode: ${missing.join(', ')}`,
    );
  }

  return {
    hostEndpoint: nonEmpty(env.ZAG_HOST_ENDPOINT),
    hostKey: nonEmpty(env.ZAG_HOST_KEY),
    controllerKey: nonEmpty(env.ZAG_CONTROLLER_KEY),
    serverEndpoint: nonEmpty(env.ZAG_SERVER_ENDPOINT),
    hostName: nonEmpty(env.ZAG_HOST_NAME) || hostname(),
    workspace: nonEmpty(env.ZAG_DEFAULT_WORKSPACE) || DEFAULT_WORKSPACE,
    initWaitMs: parseInitWaitMs(env.HARNESS_INIT_WAIT_MS),
  };
}

/** 依赖注入（测试锚定时序与副作用；生产使用默认实现）。 */
export interface CloudHostSupervisorDeps {
  env?: NodeJS.ProcessEnv;
  connect?: (endpoint: string, key: string, options?: ConnectToServerOptions) => Socket;
  makeDir?: (path: string) => Promise<void>;
  exit?: (code: number) => void;
  log?: (message: string) => void;
  /** 是否接管 SIGINT/SIGTERM（默认 true；测试关闭以免污染进程）。 */
  installSignalHandlers?: boolean;
}

export interface CloudHostSupervisorHandle {
  /** `/worker` 连接（cloud-controller）。 */
  workerSocket: Socket;
  /** controller-api 标准连接（初始化完成后才建立）。 */
  readonly controllerSocket: Socket | null;
  /** 已创建（幂等）的默认工作区。 */
  workspace: string;
  /** 关闭两端并退出（不发送 `unregister`）。 */
  shutdown: (reason: string) => void;
}

/** 日志中的连接目标：仅 origin + namespace，绝不包含 query/token。 */
function describeEndpoint(endpoint: string): string {
  const { origin, namespace } = parseEndpoint(endpoint);
  return namespace === '/' ? origin : `${origin}${namespace}`;
}

/**
 * 云电脑双连接 supervisor（契约 `agent-controller-websocket.md` §4.3）：
 *
 * 1. `mkdir -p ZAG_DEFAULT_WORKSPACE`（幂等）；
 * 2. 先连 cloud-controller `/worker`（`ZAG_SERVER_ENDPOINT` + `ZAG_CONTROLLER_KEY`）；
 * 3. `registered.initializing=true` → 等待首个 `workload:run` 批次结束（成功/失败/超时）后
 *    再连 controller-api（`ZAG_HOST_ENDPOINT` + `ZAG_HOST_KEY`）；`false`/缺省立即连接；
 * 4. 任一端 `shutdown` → 关闭两端并 `exit(0)`；**始终不发送 `unregister`**；
 * 5. 仅 controller-api 标准连接启动本地 MCP 回环服务（worker 连接跳过，避免端口冲突）。
 */
export async function startCloudHostSupervisor(
  deps: CloudHostSupervisorDeps = {},
): Promise<CloudHostSupervisorHandle> {
  const env = readCloudHostEnv(deps.env ?? process.env);
  const connect = deps.connect ?? connectToServer;
  const makeDir = deps.makeDir ?? ((path: string) => mkdir(path, { recursive: true }).then(() => undefined));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((message: string) => console.log(message));

  // 初始化脚本/工作负载需要在工作区落地前执行，先幂等创建工作区。
  await makeDir(env.workspace);
  log(`[CloudHost] workspace ready: ${env.workspace}`);

  let controllerSocket: Socket | null = null;
  let initWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let waitingForInit = false;
  let initBatchCompleted = false;
  let shutdownStarted = false;

  const clearInitTimer = (): void => {
    if (initWaitTimer) {
      clearTimeout(initWaitTimer);
      initWaitTimer = null;
    }
  };

  const shutdown = (reason: string): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    clearInitTimer();
    log(`[CloudHost] shutting down: ${reason}`);
    try {
      workerSocket.disconnect();
    } catch {
      /* socket may already be closed */
    }
    try {
      controllerSocket?.disconnect();
    } catch {
      /* socket may already be closed */
    }
    // 不发送 unregister：容器销毁由 agent-api 编排（stopCloudHost / TTL / 失败回调）。
    exit(0);
  };

  const connectController = (): void => {
    if (controllerSocket) return;
    clearInitTimer();
    waitingForInit = false;
    log(`[CloudHost] connecting controller-api: ${describeEndpoint(env.hostEndpoint)}`);
    controllerSocket = connect(env.hostEndpoint, env.hostKey, {
      serverName: env.hostName,
      handshakeToken: env.hostKey,
      handleWorkload: false,
      skipLocalMcpStart: false,
      persistConfig: false,
      onShutdown: (payload) => shutdown(`controller-api shutdown: ${payload.reason}`),
    });
  };

  const waitForInitBatch = (): void => {
    if (initBatchCompleted) {
      connectController();
      return;
    }
    if (waitingForInit) return;
    waitingForInit = true;
    log(`[CloudHost] waiting for harness initialization (timeout ${env.initWaitMs}ms)`);
    initWaitTimer = setTimeout(() => {
      initWaitTimer = null;
      // 超时后视为已完成：迟到的 registered(initializing=true) 不得再次进入等待（幽灵定时器）。
      initBatchCompleted = true;
      log('[CloudHost] harness initialization wait timed out; connecting controller-api anyway');
      connectController();
    }, env.initWaitMs);
  };

  const workerSocket = connect(env.serverEndpoint, env.controllerKey, {
    serverName: env.hostName,
    handshakeToken: env.controllerKey,
    handleWorkload: true,
    skipLocalMcpStart: true,
    persistConfig: false,
    onRegistered: (payload) => {
      log(`[CloudHost] worker registered: ${payload.controllerId}${payload.initializing ? ' (initializing)' : ''}`);
      if (payload.initializing) {
        waitForInitBatch();
      } else {
        connectController();
      }
    },
    onWorkloadBatchComplete: (summary) => {
      if (summary.phase !== 'init') return;
      if (summary.cancelled || summary.status === 'cancelled') {
        // 被新批次/销毁打断：不得视为初始化完成（重连重放 init 时 OpenCode 可能仍在安装）。
        log('[CloudHost] harness initialization interrupted; waiting for replay');
        return;
      }
      initBatchCompleted = true;
      if (waitingForInit) {
        log(
          `[CloudHost] harness initialization finished (${summary.status}` +
            `${summary.failedCount ? `, failed=${summary.failedCount}` : ''}); connecting controller-api`,
        );
        connectController();
      }
    },
    onShutdown: (payload) => shutdown(`worker shutdown: ${payload.reason}`),
  });

  if (deps.installSignalHandlers !== false) {
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  }

  return {
    workerSocket,
    get controllerSocket() {
      return controllerSocket;
    },
    workspace: env.workspace,
    shutdown,
  };
}
