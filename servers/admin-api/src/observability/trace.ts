// GENERATED FROM packages/observability/src/trace.ts — DO NOT EDIT

/**
 * W3C Trace Context 手工埋点与传播（只依赖 `@opentelemetry/api`）。
 *
 * - `withSpan`：创建 span 并把 `fn` 包进其上下文；无 SDK 时退化为直接调用（NoopTracer），零开销；
 * - `injectTraceparent` / `extractTraceparent`：`traceparent` 编解码（HTTP 头 / Socket.IO `auth` 与 `_meta` / Redis 封套 `_meta` 通用）；
 * - `publishJson`：Redis 发布封套注入 `_meta.traceparent`（不 import 任何 Redis 客户端）。
 */
import {
  context,
  trace,
  type Attributes,
  type Context,
  type Link,
  type Span,
  type SpanContext,
  SpanStatusCode,
  type SpanStatus,
} from '@opentelemetry/api';

export type PublishFn = (channel: string, body: string) => Promise<number> | number;

export interface SpanOptions {
  /** span links（如 worker `startup` span 关联 `ZAG_INIT_TRACEPARENT`） */
  links?: Link[];
  /** 父链路上下文（W3C traceparent 字符串）；缺省取当前活跃上下文 */
  parent?: string;
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** 解析并校验 `traceparent`（trim + 小写容错）；非法（长度/字符/版本/零值）返回 undefined。 */
export function parseTraceparent(value: unknown): SpanContext | undefined {
  if (typeof value !== 'string') return undefined;
  const m = TRACEPARENT_RE.exec(value.trim().toLowerCase());
  if (!m) return undefined;
  const [, version, traceId, spanId, flagsHex] = m;
  if (version !== '00') return undefined;
  if (traceId === '00000000000000000000000000000000') return undefined;
  if (spanId === '0000000000000000') return undefined;
  return {
    traceId,
    spanId,
    traceFlags: parseInt(flagsHex, 16) & 0xff,
    isRemote: true,
  };
}

/** 从载体对象（`{ traceparent }`，如 `_meta` / handshake auth）提取合法 traceparent；非法/缺失返回 undefined。 */
export function extractTraceparent(carrier: unknown): string | undefined {
  if (!carrier || typeof carrier !== 'object') return undefined;
  const raw = (carrier as Record<string, unknown>).traceparent;
  const parsed = parseTraceparent(raw);
  if (!parsed) return undefined;
  return formatTraceparent(parsed);
}

function formatTraceparent(sc: SpanContext): string {
  const flags = (sc.traceFlags ?? 0) & 0xff;
  return `00-${sc.traceId}-${sc.spanId}-${flags.toString(16).padStart(2, '0')}`;
}

function contextFromTraceparent(traceparent: string): Context | undefined {
  const sc = parseTraceparent(traceparent);
  if (!sc) return undefined;
  return trace.setSpanContext(context.active(), sc);
}

/** 当前活跃 span 的 trace/span id；无活跃 span（或 SDK 关闭）返回空对象。 */
export function currentTraceIds(): { traceId?: string; spanId?: string } {
  const sc = trace.getSpan(context.active())?.spanContext();
  if (!sc || !isRemoteOrLocalValid(sc)) return {};
  return { traceId: sc.traceId, spanId: sc.spanId };
}

function isRemoteOrLocalValid(sc: SpanContext): boolean {
  return (
    sc.traceId !== '00000000000000000000000000000000' &&
    sc.spanId !== '0000000000000000'
  );
}

/**
 * 创建 span 并在其上下文中执行 `fn`（支持 sync / async）。
 * 失败时 recordException + ERROR 状态并原样抛出；成功置 OK。
 * 无 SDK 时为 NoopTracer，退化为直接调用 `fn`。
 */
export function withSpan<T>(name: string, attrs: Attributes, fn: (span: Span) => T, opts?: SpanOptions): T;
export function withSpan<T>(name: string, attrs: Attributes, fn: (span: Span) => Promise<T>, opts?: SpanOptions): Promise<T>;
export function withSpan<T>(
  name: string,
  attrs: Attributes,
  fn: (span: Span) => T | Promise<T>,
  opts?: SpanOptions,
): T | Promise<T> {
  const parentCtx = opts?.parent ? (contextFromTraceparent(opts.parent) ?? context.active()) : context.active();
  const span = trace.getTracer('zag-observability').startSpan(name, { attributes: attrs, links: opts?.links }, parentCtx);
  const spanCtx = trace.setSpan(parentCtx, span);
  const finish = (err?: unknown): void => {
    if (err) {
      if (err instanceof Error) span.recordException(err);
      const status: SpanStatus = { code: SpanStatusCode.ERROR };
      span.setStatus(status);
    } else {
      const current = (span as { status?: { code?: number } }).status;
      if (current?.code !== SpanStatusCode.ERROR) {
        // 不覆盖调用方已置的 ERROR 状态（如 httpContext 对 5xx 的标注）
        span.setStatus({ code: SpanStatusCode.OK });
      }
    }
    span.end();
  };
  try {
    const result = context.with(spanCtx, () => fn(span));
    if (result && typeof (result as Promise<T>).then === 'function') {
      return (result as Promise<T>).then(
        (v) => {
          finish();
          return v;
        },
        (e: unknown) => {
          finish(e);
          throw e;
        },
      );
    }
    finish();
    return result;
  } catch (e) {
    finish(e);
    throw e;
  }
}

/**
 * 把当前活跃 span 的 `traceparent` 注入载体（缺省新建对象）。
 * 无活跃 span / SDK 关闭时原样返回载体（不注入无效值）。
 */
export function injectTraceparent<T extends Record<string, unknown>>(carrier?: T): T {
  const target = (carrier ?? ({} as T)) as Record<string, unknown>;
  const sc = trace.getSpan(context.active())?.spanContext();
  if (sc && isRemoteOrLocalValid(sc)) {
    target.traceparent = formatTraceparent(sc);
  }
  return target as T;
}

/**
 * Redis 发布封套：payload 顶层注入 `_meta.traceparent`（已有 `_meta` 合并、不覆盖其他键），
 * 然后 `publish(channel, JSON.stringify(body))`。消费者必须容忍 `_meta` 缺失。
 */
export function publishJson<T extends Record<string, unknown>>(
  publish: PublishFn,
  channel: string,
  payload: T,
): Promise<number> | number {
  const meta = (payload._meta as Record<string, unknown> | undefined) ?? {};
  const body = { ...payload, _meta: { ...meta, ...injectTraceparent({}) } } as Record<string, unknown>;
  return publish(channel, JSON.stringify(body));
}


