import { afterEach, describe, it, expect } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AgentApiClient } from './agent-api-client.js';

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

describe('AgentApiClient', () => {
  it('T-CC19/T-CC21: ready 回调携带 Bearer 与宿主 ID 路径', async () => {
    const { baseUrl, requests } = await startServer((_req, res) => {
      res.statusCode = 200;
      res.end('{}');
    });
    const client = new AgentApiClient({ baseUrl, token: TOKEN });

    await client.notifyReady('host-1');

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toBe('/internal/cloud-hosts/host-1/ready');
    expect(requests[0]!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('T-CC20: terminal 回调发送 status/reason 与 Bearer', async () => {
    const { baseUrl, requests } = await startServer((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    const client = new AgentApiClient({ baseUrl, token: TOKEN });

    await client.notifyTerminal('host-1', 'failed', '容器异常退出');

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('/internal/cloud-hosts/host-1/terminal');
    expect(requests[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(requests[0]!.contentType).toContain('application/json');
    expect(JSON.parse(requests[0]!.body)).toEqual({
      status: 'failed',
      reason: '容器异常退出',
    });
  });

  it('T-CC20: 非 2xx 抛出错误（由调用方告警，不阻断生命周期）', async () => {
    const { baseUrl } = await startServer((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    const client = new AgentApiClient({ baseUrl, token: TOKEN });

    await expect(client.notifyReady('host-1')).rejects.toThrow(/500/);
  });

  it('T-CC21: 超时经 AbortController 中断，不无限等待', async () => {
    // 不写响应：请求会挂起，只能由客户端超时中断。
    const { baseUrl } = await startServer(() => {});
    const client = new AgentApiClient({ baseUrl, token: TOKEN, timeoutMs: 50 });

    const started = Date.now();
    await expect(client.notifyReady('host-1')).rejects.toThrow(/timeout|abort/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('AGENT_API_URL 未配置时 no-op（不发起请求）', async () => {
    const { baseUrl, requests } = await startServer((_req, res) => {
      res.statusCode = 200;
      res.end('{}');
    });
    const client = new AgentApiClient({ baseUrl: '', token: TOKEN });
    expect(client.configured).toBe(false);

    await client.notifyReady('host-1');
    await client.notifyTerminal('host-1', 'stopped');

    expect(requests).toHaveLength(0);
    // 防御性：baseUrl 仍保持可用，避免路径污染
    expect(baseUrl.startsWith('http')).toBe(true);
  });

  it('宿主 ID 在路径中安全编码', async () => {
    const { baseUrl, requests } = await startServer((_req, res) => {
      res.statusCode = 200;
      res.end('{}');
    });
    const client = new AgentApiClient({ baseUrl, token: TOKEN });

    await client.notifyReady('host/with space');

    expect(requests[0]!.url).toBe('/internal/cloud-hosts/host%2Fwith%20space/ready');
  });
});
