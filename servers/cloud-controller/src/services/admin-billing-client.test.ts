import { afterEach, describe, it, expect } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AdminBillingClient } from './admin-billing-client.js';

const TOKEN = 'test-internal-token';

interface CapturedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
}

const servers: HttpServer[] = [];

async function startServer(
  handler: (req: CapturedRequest, res: import('node:http').ServerResponse) => void,
): Promise<{ baseUrl: string; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body,
      };
      requests.push(captured);
      handler(captured, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('AdminBillingClient', () => {
  it('T-CC20: revoke-by-host 携带 Bearer 与 { cloudHostId }，幂等成功', async () => {
    const { baseUrl, requests } = await startServer((_req, res) => {
      res.statusCode = 200;
      res.end('{"revoked":1}');
    });
    const client = new AdminBillingClient({ baseUrl, token: TOKEN });

    await client.revokeByHost('host-1');
    await client.revokeByHost('host-1');

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/internal/billing/api-keys/revoke-by-host');
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(request.body)).toEqual({ cloudHostId: 'host-1' });
    }
  });

  it('T-CC20: 失败抛出（由调用方告警，不阻断容器生命周期）', async () => {
    const { baseUrl } = await startServer((_req, res) => {
      res.statusCode = 503;
      res.end('unavailable');
    });
    const client = new AdminBillingClient({ baseUrl, token: TOKEN });

    await expect(client.revokeByHost('host-1')).rejects.toThrow(/503/);
  });

  it('T-CC21: 超时经 AbortController 中断', async () => {
    const { baseUrl } = await startServer(() => {});
    const client = new AdminBillingClient({ baseUrl, token: TOKEN, timeoutMs: 50 });

    const started = Date.now();
    await expect(client.revokeByHost('host-1')).rejects.toThrow(/timeout|abort/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('ADMIN_API_URL 未配置时 no-op', async () => {
    const { baseUrl, requests } = await startServer((_req, res) => {
      res.statusCode = 200;
      res.end('{}');
    });
    const client = new AdminBillingClient({ baseUrl: '', token: TOKEN });
    expect(client.configured).toBe(false);

    await client.revokeByHost('host-1');
    expect(requests).toHaveLength(0);
    expect(baseUrl.startsWith('http')).toBe(true);
  });
});
