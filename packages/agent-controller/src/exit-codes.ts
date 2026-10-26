/**
 * 进程退出码分类（契约 `agent-controller-websocket.md` §3.7）。
 *
 * 三分口径：
 * - `42` 服务端终止（`unregistered` / 非失败类 `shutdown` / `error: INVALID_TOKEN`）→ 入口不重启；
 * - `0` 自发 / 信号退出（`SIGINT` / `SIGTERM`）→ 入口保活重启（误杀恢复）；
 * - `1` 失败类（`version_mismatch:*` / 其它 `error:*` / 初始化失败）→ 入口退避自更新后重启。
 *
 * `socketio-client.ts` 与 `cloud-host/supervisor.ts` 共用本模块，避免两者循环依赖。
 */

/** 服务端终止退出码：容器入口视为正常结束、不重启。 */
export const EXIT_SERVER_SHUTDOWN = 42;

/** 信号类退出码：入口保活重启。 */
export const EXIT_SIGNAL_SHUTDOWN = 0;

/** 失败类退出码：入口退避自更新后重启。 */
export const EXIT_FAILURE_SHUTDOWN = 1;

/**
 * 错误/失败类 reason 判定（自 supervisor 逐字迁移，语义不得变更）。
 */
export function isFailureShutdownReason(reason: string): boolean {
  const normalized = reason.trim().toLowerCase();
  if (normalized.includes('version_mismatch:') || /(^|[\s:])error:/.test(normalized)) {
    return true;
  }
  return (
    reason.includes('初始化失败') ||
    normalized.includes('init failed') ||
    normalized.includes('initialization failed')
  );
}

/** 信号终止 reason（允许 `signal: SIGTERM` 形态）。 */
export function isSignalShutdownReason(reason: string): boolean {
  return /(^|[\s:])(sigint|sigterm)\s*$/i.test(reason.trim());
}

/** 服务端终止 reason（42）：`unregistered` 或 `error: INVALID_TOKEN`（可带包装前缀）。 */
export function isServerTerminationReason(reason: string): boolean {
  const normalized = reason.trim().toLowerCase();
  return (
    normalized.includes('unregistered') ||
    /(^|[\s:])error:\s*invalid_token\b/.test(normalized)
  );
}

/**
 * 由 reason 推导退出码：信号 0 → 服务端终止 42 → 失败 1 → 其余 42。
 * 判定顺序保证 `INVALID_TOKEN`（虽匹配 `error:`）归 42。
 */
export function resolveShutdownExitCode(reason: string): number {
  if (isSignalShutdownReason(reason)) return EXIT_SIGNAL_SHUTDOWN;
  if (isServerTerminationReason(reason)) return EXIT_SERVER_SHUTDOWN;
  if (isFailureShutdownReason(reason)) return EXIT_FAILURE_SHUTDOWN;
  return EXIT_SERVER_SHUTDOWN;
}
