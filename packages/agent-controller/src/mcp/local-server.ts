import http from 'node:http';
import { McpRelay } from './relay.js';
import { logger as rootLogger, type ObservationLogger } from '../observability/logger.js';

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export class LocalMcpServer {
  private relay: McpRelay;
  private server: http.Server;
  private log: ObservationLogger;

  constructor(relay: McpRelay, logger?: ObservationLogger) {
    this.relay = relay;
    this.log = logger ?? rootLogger.child({ component: 'mcp-local' });
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get port(): number {
    const address = this.server.address();
    if (address && typeof address === 'object') return address.port;
    return 0;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const startedAt = Date.now();
    this.log.debug({ event: 'mcp_request', method: req.method, url: req.url, accept: req.headers.accept ?? null }, 'mcp request');
    if (req.method !== 'POST') {
      this.log.debug({ event: 'mcp_request_rejected', status: 405, reason: 'method_not_allowed' }, 'mcp request rejected');
      res.writeHead(405);
      res.end();
      return;
    }
    const match = /^\/mcp\/([^/]+)\/([^/]+)\/?$/.exec(req.url ?? '');
    if (!match) {
      this.log.debug({ event: 'mcp_request_rejected', status: 404, reason: 'bad_path' }, 'mcp request rejected');
      res.writeHead(404);
      res.end();
      return;
    }
    const sessionId = decodeURIComponent(match[1]);
    const serverName = decodeURIComponent(match[2]);

    if (!this.relay.hasSession(sessionId)) {
      this.log.debug(
        { event: 'mcp_request_rejected', status: 404, reason: 'session_not_registered', sessionId, serverName },
        'mcp request rejected',
      );
      res.writeHead(404);
      res.end();
      return;
    }
    if (!this.relay.hasServer(sessionId, serverName)) {
      this.log.debug(
        { event: 'mcp_request_rejected', status: 404, reason: 'server_not_assembled', sessionId, serverName },
        'mcp request rejected',
      );
      res.writeHead(404);
      res.end();
      return;
    }
    if (!req.headers.authorization) {
      this.log.debug(
        { event: 'mcp_request_rejected', status: 401, reason: 'missing_authorization', sessionId, serverName },
        'mcp request rejected',
      );
      res.writeHead(401);
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        tooLarge = true;
        // 立即断流并响应 502，避免继续累加超限请求体 / 挂起等待 'end'
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: 'PAYLOAD_TOO_LARGE', message: 'MCP request body exceeds 16MB' } }));
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (tooLarge) return;
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = JSON.parse(bodyStr || '{}');
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      try {
        const rpcMethod = (body as { method?: string })?.method ?? '?';
        const result = await this.relay.forward(sessionId, serverName, body);
        this.log.debug(
          {
            event: 'mcp_request_completed',
            sessionId,
            serverName,
            method: rpcMethod,
            status: result.status,
            durationMs: Date.now() - startedAt,
          },
          'mcp request completed',
        );
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      } catch (err) {
        this.log.error({ event: 'mcp_forward_failed', sessionId, serverName, err }, 'mcp forward failed');
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: 'FORWARD_ERROR', message: 'MCP forward failed' } }));
      }
    });
  }
}