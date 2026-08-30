import http from 'node:http';
import { McpRelay } from './relay.js';

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export class LocalMcpServer {
  private relay: McpRelay;
  private server: http.Server;

  constructor(relay: McpRelay) {
    this.relay = relay;
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
    console.log(`[MCP local] ${req.method} ${req.url} accept=${req.headers.accept ?? '-'}`);
    if (req.method !== 'POST') {
      console.log(`[MCP local] -> 405 (method not allowed)`);
      res.writeHead(405);
      res.end();
      return;
    }
    const match = /^\/mcp\/([^/]+)\/([^/]+)\/?$/.exec(req.url ?? '');
    if (!match) {
      console.log(`[MCP local] -> 404 (bad path)`);
      res.writeHead(404);
      res.end();
      return;
    }
    const sessionId = decodeURIComponent(match[1]);
    const serverName = decodeURIComponent(match[2]);

    if (!this.relay.hasSession(sessionId)) {
      console.log(`[MCP local] ${sessionId}/${serverName} -> 404 (session not registered in relay)`);
      res.writeHead(404);
      res.end();
      return;
    }
    if (!this.relay.hasServer(sessionId, serverName)) {
      console.log(`[MCP local] ${sessionId}/${serverName} -> 404 (server not assembled in session)`);
      res.writeHead(404);
      res.end();
      return;
    }
    if (!req.headers.authorization) {
      console.log(`[MCP local] ${sessionId}/${serverName} -> 401 (missing Authorization)`);
      res.writeHead(401);
      res.end();
      return;
    }

    let bodyStr = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      bodyStr += chunk;
      if (Buffer.byteLength(bodyStr) > MAX_BODY_BYTES) {
        tooLarge = true;
        // 立即断流并响应 502，避免继续累加超限请求体 / 挂起等待 'end'
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: 'PAYLOAD_TOO_LARGE', message: 'MCP request body exceeds 16MB' } }));
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (tooLarge) return;
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
        console.log(`[MCP local] ${sessionId}/${serverName} ${rpcMethod} -> ${result.status} (${Date.now() - startedAt}ms)`);
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      } catch (err) {
        console.error(`[MCP local] forward failed: session=${sessionId} server=${serverName}: ${(err as Error).message}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: 'FORWARD_ERROR', message: 'MCP forward failed' } }));
      }
    });
  }
}