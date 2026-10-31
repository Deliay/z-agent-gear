/**
 * HTTP 请求上下文中间件：requestId 归一化 + traceparent 提取 + SERVER span + 访问日志。
 *
 * - 不读 body（agent-api webhook 需先验签，F10）；
 * - `/health` 与 K8s 探针路径降噪（debug 级别）；SSE 只记连接建立/断开（D8）；
 * - 响应头回写 `x-request-id`；入站非法标注 `requestIdReplaced: true`（D5）。
 */
import { randomUUID } from 'node:crypto';
import { context, SpanStatusCode, type Attributes } from '@opentelemetry/api';
import { readContext, runWithLogContext, type LogContext } from './log-context.js';
import { logger as rootLogger, type ObservationLogger } from './logger.js';
import { withSpan } from './trace.js';

/** 结构化最小请求面（不依赖 express 类型，agent-gear 无 express 也可 vendor）。 */
export interface HttpContextRequest {
  method?: string;
  path?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  route?: { path?: string | string[] };
  ip?: string;
}

export interface HttpContextResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  on(event: string, listener: () => void): unknown;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** 入站合法沿用；缺失生成 UUID v4；非法生成 UUID v4 并置 `replaced`（D5）。 */
export function normalizeRequestId(raw: string | undefined): { requestId: string; replaced: boolean } {
  if (raw !== undefined && REQUEST_ID_RE.test(raw)) return { requestId: raw, replaced: false };
  return { requestId: randomUUID(), replaced: raw !== undefined };
}

const HEALTH_PATHS = new Set(['/health', '/healthz', '/readyz', '/livez', '/api/health']);
const SSE_PATH = '/api/session-stream';

function headerValue(req: HttpContextRequest, name: string): string | undefined {
  const raw = req.headers?.[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * `app.use(httpContext())`：挂载在 `cors()` 之后、业务路由之前。
 * `opts.logger` 仅供测试注入；缺省用进程级单例。
 */
export function httpContext(
  opts: { logger?: ObservationLogger } = {},
): (req: HttpContextRequest, res: HttpContextResponse, next: () => void) => void {
  const log = opts.logger ?? rootLogger;
  return (req, res, next) => {
    const { requestId, replaced } = normalizeRequestId(headerValue(req, 'x-request-id'));
    res.setHeader('x-request-id', requestId);

    const logCtx: LogContext = { requestId, ...(replaced ? { requestIdReplaced: true } : {}) };
    runWithLogContext(logCtx, () => {
      const method = req.method ?? 'GET';
      const routePath = (Array.isArray(req.route?.path) ? req.route?.path[0] : req.route?.path) ?? req.path ?? req.url ?? '/';
      const name = `${method} ${routePath}`;
      const isHealth = HEALTH_PATHS.has(routePath);
      const isSse = routePath === SSE_PATH;
      const attrs: Attributes = {
        'http.request.method': method,
        'url.path': routePath,
        'url.scheme': 'http',
      };
      const parent = headerValue(req, 'traceparent');
      void withSpan(
        name,
        attrs,
        (span) => {
          return new Promise<void>((resolve) => {
            const startedAt = Date.now();
            const logCtxInner = context.active();
            let done = false;
            const finish = (): void => {
              if (done) return;
              done = true;
              const status = res.statusCode;
              const durationMs = Date.now() - startedAt;
              span.setAttribute('http.response.status_code', status);
              if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
              context.with(logCtxInner, () => {
                runWithLogContext(logCtx, () => {
                  const fields = { component: 'http', method, path: routePath, status, durationMs };
                  if (isSse) {
                    log.info(fields, 'sse disconnected');
                  } else if (isHealth) {
                    log.debug(fields, 'request completed');
                  } else {
                    log.info(fields, 'request completed');
                  }
                });
              });
              resolve();
            };
            res.on('finish', finish);
            res.on('close', finish);
            if (isSse) {
              log.info({ component: 'http', method, path: routePath }, 'sse connected');
            }
            next();
          });
        },
        { parent },
      );
    });
  };
}

/** 供测试/调用方读取当前请求上下文标识。 */
export function currentRequestId(): string | undefined {
  return readContext().requestId;
}
