import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import { LocalMcpServer } from './local-server.js';

interface FakeRelay {
  hasSession: (id: string) => boolean;
  hasServer: (id: string, name: string) => boolean;
  forward: (sessionId: string, serverName: string, body: unknown) => Promise<{ status: number; body: unknown }>;
}

function makeRelay(options?: { session?: string; server?: string }): FakeRelay {
  const session = options?.session ?? 'sess-1';
  const server = options?.server ?? 'github-mcp';
  return {
    hasSession: (id) => id === session,
    hasServer: (id, name) => id === session && name === server,
    forward: vi.fn(async () => ({ status: 200, body: { result: 'ok' } })),
  };
}

async function startServer(relay: FakeRelay): Promise<LocalMcpServer> {
  const server = new LocalMcpServer(relay as never);
  await server.start();
  return server;
}

function request(
  server: LocalMcpServer,
  method: string,
  path: string,
  headers?: Record<string, string>,
  body?: string,
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.port, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const AUTH = { authorization: 'Bearer tok-1' };

function httpAddress(server: LocalMcpServer): { address: string; port: number } {
  return (server as unknown as { server: http.Server }).server.address() as { address: string; port: number };
}

describe('LocalMcpServer', () => {
  it('T-C1 forwards a valid POST to the relay and writes back the response', async () => {
    const relay = makeRelay();
    const server = await startServer(relay);
    const path = '/mcp/sess-1/github-mcp';
    const res = await request(server, 'POST', path, AUTH, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));

    expect(relay.forward).toHaveBeenCalledWith('sess-1', 'github-mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.data)).toEqual({ result: 'ok' });
    await server.stop();
  });

  it('T-C2 fast-fails unregistered session (404), out-of-snapshot server (404), missing Authorization (401)', async () => {
    const relay = makeRelay({ session: 'sess-1', server: 'github-mcp' });
    const server = await startServer(relay);
    const body = JSON.stringify({ id: 1 });

    const unregistered = await request(server, 'POST', '/mcp/ghost-mcp/anything', AUTH, body);
    expect(unregistered.status).toBe(404);

    const unknownServer = await request(server, 'POST', '/mcp/sess-1/unknown-server', AUTH, body);
    expect(unknownServer.status).toBe(404);

    const noAuth = await request(server, 'POST', '/mcp/sess-1/github-mcp', undefined, body);
    expect(noAuth.status).toBe(401);

    expect(relay.forward).not.toHaveBeenCalled();
    await server.stop();
  });

  it('T-C3 returns 405 for GET', async () => {
    const relay = makeRelay();
    const server = await startServer(relay);
    const res = await request(server, 'GET', '/mcp/sess-1/github-mcp');
    expect(res.status).toBe(405);
    expect(relay.forward).not.toHaveBeenCalled();
    await server.stop();
  });

  it('T-C4 listens only on 127.0.0.1 with an ephemeral port > 0', async () => {
    const relay = makeRelay();
    const server = await startServer(relay);
    const address = httpAddress(server);
    expect(address.address).toBe('127.0.0.1');
    expect(address.port).toBeGreaterThan(0);
    expect(server.port).toBe(address.port);
    await server.stop();
  });

  it('T-C5 concurrent requests resolve independently without interfering', async () => {
    const resolvers: Array<(v: { status: number; body: unknown }) => void> = [];
    const relay: FakeRelay = {
      hasSession: (id) => id === 'sess-1',
      hasServer: (id, name) => id === 'sess-1' && name === 'github-mcp',
      forward: vi.fn(() => new Promise<{ status: number; body: unknown }>((resolve) => {
        resolvers.push(resolve);
      })),
    };
    const server = await startServer(relay);

    const p1 = request(server, 'POST', '/mcp/sess-1/github-mcp', AUTH, JSON.stringify({ id: 1 }));
    const p2 = request(server, 'POST', '/mcp/sess-1/github-mcp', AUTH, JSON.stringify({ id: 2 }));
    const p3 = request(server, 'POST', '/mcp/sess-1/github-mcp', AUTH, JSON.stringify({ id: 3 }));

    await new Promise((r) => setTimeout(r, 20));
    expect(relay.forward).toHaveBeenCalledTimes(3);
    expect(resolvers).toHaveLength(3);

    resolvers[0]({ status: 200, body: { result: 'first' } });
    resolvers[1]({ status: 504, body: { error: 'TIMEOUT' } });
    resolvers[2]({ status: 200, body: { result: 'third' } });

    expect((await p1).status).toBe(200);
    expect((await p2).status).toBe(504);
    expect((await p3).status).toBe(200);
    await server.stop();
  });
});