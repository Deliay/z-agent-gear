import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Server as SocketIOServer } from 'socket.io';
import { type ObservationLogger } from '../observability/logger.js';

/**
 * Socket.IO 传输层诊断日志。
 *
 * 背景：worker 经 Ingress 以 `wss://<host>/worker` 回连，`/worker` 是 Socket.IO **namespace**，
 * 真正的握手/升级 HTTP 请求打的是 engine path（`/socket.io/`）。且 websocket 传输的握手走 HTTP
 * **upgrade** 事件，**不经过 express 中间件**——如果只依赖业务日志，请求打错路径或根本到不了
 * Pod 时 controller 会「静默无日志」。
 *
 * 本模块在最底层补三条线索，用于区分「请求到没到 Pod」「到的是哪条路径」「engine 层为何拒绝」：
 *   1. 每个 WS upgrade 请求（进入 Socket.IO 之前）记录 path/host/X-Forwarded-*、UA；
 *      路径与 engine path 不一致时直接 warn（典型：Ingress 误配成 `/worker`）。
 *   2. HTTP 请求（polling / 误配路径 / `/health`）记录状态码。
 *   3. engine 的 `connection_error`（协议版本/CORS/传输握手失败等）记录 code/message/context。
 */
export interface SocketDiagnosticsOptions {
  httpServer: HttpServer;
  io: SocketIOServer;
  logger: ObservationLogger;
  /** 服务端 engine path（`ENGINE_PATH`，形如 `/socket.io/`）。 */
  enginePath: string;
}

interface EngineConnectionError {
  req?: IncomingMessage;
  code: number;
  message: string;
  context?: unknown;
}

function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw.join(',');
  return raw ?? '-';
}

/** 请求识别字段（原 `requestLine` 拼接串的结构化形态，变量一律进字段）。 */
function requestFields(req: IncomingMessage): Record<string, unknown> {
  return {
    method: req.method,
    url: req.url ?? '-',
    host: req.headers.host ?? '-',
    xForwardedProto: headerValue(req, 'x-forwarded-proto'),
    xForwardedFor: headerValue(req, 'x-forwarded-for'),
    userAgent: headerValue(req, 'user-agent'),
    remoteAddress: req.socket?.remoteAddress ?? '-',
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return String(value);
  }
}

export function wireSocketDiagnostics({
  httpServer,
  io,
  logger,
  enginePath,
}: SocketDiagnosticsOptions): void {
  const normalizedEnginePath = enginePath.endsWith('/') ? enginePath : `${enginePath}/`;
  const bareEnginePath = normalizedEnginePath.replace(/\/$/, '');
  const isEnginePath = (path: string): boolean =>
    path === normalizedEnginePath || path === bareEnginePath;

  // 1) WS upgrade：在 Socket.IO 之前记录（websocket 传输不经 express，业务日志看不到）。
  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, _head: Buffer) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (isEnginePath(path)) {
      logger.info(
        {
          component: 'socket-diagnostics',
          event: 'ws-upgrade-accepted',
          path,
          ...requestFields(req),
        },
        'ws upgrade accepted',
      );
    } else {
      logger.warn(
        {
          component: 'socket-diagnostics',
          event: 'ws-upgrade-path-mismatch',
          path,
          expectedPath: normalizedEnginePath,
          ...requestFields(req),
        },
        'upgrade path mismatch — Ingress 必须放行 engine path（"/worker" 是 namespace，不是 URL 路径）',
      );
    }
    socket.on('error', (err: Error) => {
      logger.warn(
        { component: 'socket-diagnostics', event: 'upgrade-socket-error', path, err },
        'upgrade socket error',
      );
    });
  });

  // 2) 普通 HTTP 请求：记录状态码；命中 /worker 之类误配置路径时给出明确提示。
  httpServer.on('request', (req: IncomingMessage, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    res.on('finish', () => {
      if (isEnginePath(path)) {
        logger.info(
          {
            component: 'socket-diagnostics',
            event: 'http-request',
            path,
            statusCode: res.statusCode,
            ...requestFields(req),
          },
          'engine path http request',
        );
      } else if (path === '/worker' || path.startsWith('/worker/')) {
        logger.warn(
          {
            component: 'socket-diagnostics',
            event: 'worker-path-request',
            path,
            statusCode: res.statusCode,
            expectedPath: normalizedEnginePath,
          },
          '"/worker" 是 Socket.IO namespace，不是 URL 路径；Ingress 应放行 engine path',
        );
      } else {
        logger.debug(
          {
            component: 'socket-diagnostics',
            event: 'http-request',
            method: req.method,
            path,
            statusCode: res.statusCode,
          },
          'http request',
        );
      }
    });
  });

  // 3) engine 层错误：协议版本 / CORS / 传输握手失败等。
  io.engine.on('connection_error', (err: EngineConnectionError) => {
    logger.warn(
      {
        component: 'socket-diagnostics',
        event: 'engine-connection-error',
        code: err.code,
        err: { message: err.message, code: err.code },
        context: safeJson(err.context),
        ...(err.req ? requestFields(err.req) : {}),
      },
      'engine connection_error',
    );
  });
}
