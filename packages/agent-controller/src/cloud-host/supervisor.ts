import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import type { Socket } from 'socket.io-client';
import {
  connectToServer,
  parseEndpoint,
  type ConnectToServerOptions,
} from '../socketio-client.js';
import {
  GithubCredentialManager,
  type GithubCredentialRefreshResult,
} from '../github/credential-manager.js';
import type { WorkloadRunPayload } from '../workload-executor.js';

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
  /** agent-api 内部地址（env `ZAG_AGENT_API_ENDPOINT`；缺失时凭据管理器禁用）。 */
  agentApiEndpoint?: string;
  /** 云主机 controllerId（env `ZAG_CONTROLLER_ID`；缺失时凭据管理器禁用）。 */
  controllerId?: string;
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
    agentApiEndpoint: nonEmpty(env.ZAG_AGENT_API_ENDPOINT) || undefined,
    controllerId: nonEmpty(env.ZAG_CONTROLLER_ID) || undefined,
  };
}

/** 凭据管理器最小接口（supervisor 只依赖生命周期与 refreshNow，便于测试注入）。 */
export interface CredentialManagerLike {
  start(): void;
  stop(): void;
  refreshNow(): Promise<GithubCredentialRefreshResult>;
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
  /** 注入 Github 凭据管理器（测试用）；缺省按容器 env 创建。 */
  credentialManager?: CredentialManagerLike;
}

export interface CloudHostSupervisorHandle {
  /** `/worker` 连接（cloud-controller）。 */
  workerSocket: Socket;
  /** controller-api 标准连接（初始化完成后才建立）。 */
  readonly controllerSocket: Socket | null;
  /** 已创建（幂等）的默认工作区。 */
  workspace: string;
  /**
   * 关闭两端并退出（不发送 `unregister`）。
   *
   * `code` 缺省按 `reason` 自动判定：服务端主动 shutdown / 信号 / unregistered → 0；
   * `version_mismatch:*` / `error:*` / 初始化失败类 → 1（避免错误路径 `exit(0)` 掩盖失败，
   * 并让 entrypoint 的 VERSION_MISMATCH 自愈生效，C-2）。
   */
  shutdown: (reason: string, code?: number) => void;
}

/**
 * 错误/失败类 shutdown reason 判定（C-2）：
 *
 * - `socketio-client` 把 `VERSION_MISMATCH` / 其它 `error` 事件转成
 *   `version_mismatch:*` / `error:<code>` 前缀；
 * - cloud-controller 的必须工作负载失败 reason 形如「必须工作负载「x」初始化失败」
 *   （经 `worker shutdown: ...` 包装后仍需识别）；
 * - 其余（服务端主动 shutdown、`unregistered`、SIGINT/SIGTERM）视为正常退出。
 */
export function isFailureShutdownReason(reason: string): boolean {
  const normalized = reason.trim().toLowerCase();
  // reason 可能被 `worker shutdown:` / `controller-api shutdown:` 包装，用 includes 判定前缀。
  if (normalized.includes('version_mismatch:') || /(^|[\s:])error:/.test(normalized)) {
    return true;
  }
  return (
    reason.includes('初始化失败') ||
    normalized.includes('init failed') ||
    normalized.includes('initialization failed')
  );
}

/** 由 shutdown reason 推导退出码：失败路径 1、正常退出 0。 */
export function resolveShutdownExitCode(reason: string): number {
  return isFailureShutdownReason(reason) ? 1 : 0;
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
 * 4. 任一端 `shutdown` → 关闭两端并退出（正常 0；`version_mismatch`/`error`/初始化失败 1）；**始终不发送 `unregister`**；
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

  // Github 凭据管理器：env 缺失时自身只 warn 并禁用，绝不阻塞云主机上线。
  const credentialManager =
    deps.credentialManager ??
    new GithubCredentialManager({ env: deps.env ?? process.env, log });
  credentialManager.start();

  const beforeWorkloadBatch = async (payload: WorkloadRunPayload): Promise<void> => {
    if (payload.githubAuth !== true) return;
    const result = await credentialManager.refreshNow();
    if (result.ok) return;
    if (result.error === 'no-binding') throw new Error('未设置 Github 项目');
    if (result.error === 'disabled') throw new Error('云主机未配置 Github 凭据申请环境');
    throw new Error(result.error || 'Github 凭据申请失败');
  };

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

  const shutdown = (reason: string, code?: number): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    clearInitTimer();
    const exitCode = code ?? resolveShutdownExitCode(reason);
    log(`[CloudHost] shutting down: ${reason} (exit ${exitCode})`);
    credentialManager.stop();
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
    // 失败/版本不兼容路径必须非零退出：Job 终态映射为 failed，且 entrypoint 的自愈升级生效（C-2）。
    exit(exitCode);
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
    onBeforeWorkloadBatch: beforeWorkloadBatch,
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
