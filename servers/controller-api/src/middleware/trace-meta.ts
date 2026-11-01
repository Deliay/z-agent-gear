import { injectTraceparent } from '../observability/trace.js';

/**
 * 服务端下发报文统一注入顶层 `_meta`（契约 agent-session-websocket.md §7）：
 * payload 为普通对象时 `{ ...payload, _meta: { ...(已有 _meta 对象), ...injectTraceparent({}) } }`；
 * 无活跃 span 时 `_meta` 为空对象（不注入无效 traceparent）。非普通对象原样返回。
 * 与 cloud-controller `services/socketio-gateway.ts` 的 `withTraceMeta` 同型；
 * 旧 controller 忽略未知字段，既有 payload 字段不受影响，所有消费者容忍 `_meta` 缺失/为空。
 */
export function withTraceMeta<T>(payload: T): T {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  const existing = record._meta;
  const meta =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return { ...record, _meta: { ...meta, ...injectTraceparent({}) } } as T;
}
