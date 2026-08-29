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
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    const match = /^\/mcp\/([^/]+)\/([^/]+)\/?$/.exec(req.url ?? '');
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }
    const sessionId = decodeURIComponent(match[1]);
    const serverName = decodeURIComponent(match[2]);

    if (!this.relay.hasSession(sessionId)) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!this.relay.hasServer(sessionId, serverName)) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!req.headers.authorization) {
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
        const result = await this.relay.forward(sessionId, serverName, body);
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