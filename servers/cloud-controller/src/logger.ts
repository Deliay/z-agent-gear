/**
 * 轻量日志器：统一 cloud-controller 的日志出口与级别控制。
 *
 * - 输出全部走 console（stdout/stderr），K8s 由容器运行时采集，`kubectl logs` 直接可见，无需额外配置；
 * - 级别由 `LOG_LEVEL` 环境变量控制（`debug|info|warn|error`，默认 `info`）；
 *   排查 worker 回连（Socket.IO 握手 / engine path / Ingress 路径）时，把 `LOG_LEVEL=debug`
 *   可看到逐请求日志（例如误配路径的 HTTP 探测）。
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface LoggerSink {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** 解析 `LOG_LEVEL`；非法/缺省回落到 `info`。 */
export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === 'debug' ||
    normalized === 'info' ||
    normalized === 'warn' ||
    normalized === 'error'
    ? normalized
    : DEFAULT_LOG_LEVEL;
}

export function createLogger(level: LogLevel = DEFAULT_LOG_LEVEL, sink: LoggerSink = console): Logger {
  const threshold = LEVEL_WEIGHT[level];
  const at = (target: LogLevel): ((...args: unknown[]) => void) => {
    if (LEVEL_WEIGHT[target] < threshold) return () => {};
    return (...args) => sink[target](...args);
  };
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
}
