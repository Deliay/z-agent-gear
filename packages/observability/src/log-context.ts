/**
 * 进程内日志上下文（AsyncLocalStorage）。
 *
 * `runWithLogContext(ctx, fn)` 把 ctx **合并**入当前上下文（不整体覆盖）；
 * 已存在的键不被嵌套调用覆盖（先写入者优先，见 contracts/observability.md §5.3）。
 * `logger` 的 `mixin()` 在打日志时自动注入，业务代码不手工传 `requestId` 等字段。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContext {
  requestId?: string;
  userId?: string;
  tenantId?: string;
  workspaceId?: string;
  sessionId?: string;
  controllerId?: string;
  cloudHostId?: string;
  containerId?: string;
  workflowInstanceId?: string;
  nodeId?: string;
  /** 入站 `x-request-id` 非法被替换时置 true（D5，不静默替换） */
  requestIdReplaced?: boolean;
}

const storage = new AsyncLocalStorage<LogContext>();

/** 读取当前日志上下文；无上下文时返回空对象（不抛错）。 */
export function readContext(): LogContext {
  return storage.getStore() ?? {};
}

/** 在合并后的上下文中执行 `fn`：ctx 的键合并入当前上下文，**已存在的键不被覆盖**。 */
export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  const existing = storage.getStore();
  const merged: LogContext = existing ? { ...ctx, ...existing } : { ...ctx };
  return storage.run(merged, fn);
}
