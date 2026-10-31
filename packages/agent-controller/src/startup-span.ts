import type { Attributes, Link } from '@opentelemetry/api';
import { parseTraceparent, withSpan } from './observability/trace.js';

/**
 * `startup` span 与 `ZAG_INIT_TRACEPARENT` link（T-OBS18）。
 *
 * cloud-controller 创建云电脑 Job 时把 `container.start` span 的 traceparent 注入
 * `ZAG_INIT_TRACEPARENT`；agent-gear 启动时以 **link**（不是 parent）关联创建链路。
 * 未注入 / 非法值 → 无 links（不注入无效上下文）。
 */
export function startupLinks(env: NodeJS.ProcessEnv = process.env): Link[] {
  const spanContext = parseTraceparent(env.ZAG_INIT_TRACEPARENT);
  return spanContext ? [{ context: spanContext }] : [];
}

/**
 * 创建 `startup` span 并在其上下文中执行 `fn`。
 * `ZAG_INIT_TRACEPARENT` 存在且合法时 `links[0].context.traceId` 等于注入值的 trace-id。
 */
export function withStartupSpan<T>(
  attrs: Attributes,
  fn: () => T | Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): T | Promise<T> {
  const links = startupLinks(env);
  return withSpan('startup', attrs, fn, links.length > 0 ? { links } : undefined);
}
