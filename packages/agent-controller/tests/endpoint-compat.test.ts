import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as IOServer, type Socket as ServerSocket } from 'socket.io';

// 只测连接层：屏蔽守护进程的其余副作用（本地 MCP 回环服务、心跳定时器、~/.zag 配置写入）。
vi.mock('../src/mcp/local-server.js', () => ({
  LocalMcpServer: class {
    port = 0;
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
  },
}));

vi.mock('../src/heartbeat.js', () => ({
  Heartbeat: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));

vi.mock('../src/config.js', () => ({
  clearConfigKey: vi.fn(),
  saveKeyToConfig: vi.fn(),
  saveEndpointToConfig: vi.fn(),
  getResumeTokenFromConfig: vi.fn(() => undefined),
  saveResumeTokenToConfig: vi.fn(),
  clearResumeTokenFromConfig: vi.fn(),
}));

import { connectToServer, parseEndpoint, extractHandshakeToken, stripTokenFromEndpoint } from '../src/socketio-client.js';
import type { Socket } from 'socket.io-client';

interface Harness {
  port: number;
  handshakes: Array<Record<string, string>>;
  auths: Array<Record<string, unknown>>;
  registerPayloads: unknown[];
  url: (path?: string) => string;
  close: () => Promise<void>;
}

const openSockets: Socket[] = [];

async function startServer(): Promise<Harness> {
  const httpServer: HttpServer = createServer();
  const ioServer = new IOServer(httpServer);
  const handshakes: Array<Record<string, string>> = [];
  const auths: Array<Record<string, unknown>> = [];
  const registerPayloads: unknown[] = [];

  const attach = (nspName: string) => {
    const nsp = ioServer.of(nspName);
    nsp.use((socket, next) => {
      handshakes.push(socket.handshake.query as Record<string, string>);
      auths.push(socket.handshake.auth as Record<string, unknown>);
      next();
    });
    nsp.on('connection', (socket: ServerSocket) => {
      socket.on('register', (payload: unknown) => {
        registerPayloads.push(payload);
        socket.emit('registered', { controllerId: 'test-controller' });
      });
    });
  };
  attach('/');
  attach('/worker');

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  const port = address.port;

  return {
    port,
    handshakes,
    auths,
    registerPayloads,
    url: (path = '') => `http://127.0.0.1:${port}${path}`,
    close: async () => {
      await ioServer.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

afterEach(async () => {
  for (const socket of openSockets.splice(0)) {
    socket.close();
  }
});

describe('parseEndpoint', () => {
  it('T-P1：旧 endpoint 解析为默认 namespace `/` 且无 query', () => {
    const parsed = parseEndpoint('http://host:4001');
    expect(parsed.namespace).toBe('/');
    expect(parsed.query).toEqual({});
    expect(parsed.origin).toBe('http://host:4001');
  });

  it('T-P2：新 endpoint 解析出 `/worker` namespace 与 token query', () => {
    const parsed = parseEndpoint('wss://cloud.example.com/worker?token=abc');
    expect(parsed.namespace).toBe('/worker');
    expect(parsed.query).toEqual({ token: 'abc' });
    expect(parsed.origin).toBe('wss://cloud.example.com');
  });

  it('忽略尾部斜杠、保留多 query 参数', () => {
    const parsed = parseEndpoint('wss://cloud.example.com/worker/?token=a.b&x=1');
    expect(parsed.namespace).toBe('/worker');
    expect(parsed.query).toEqual({ token: 'a.b', x: '1' });
  });

  it('extractHandshakeToken 取 query token；stripTokenFromEndpoint 移除之而保留其他参数', () => {
    expect(extractHandshakeToken('wss://h/worker?token=a.b')).toBe('a.b');
    expect(extractHandshakeToken('wss://h/worker')).toBeUndefined();
    expect(extractHandshakeToken('not-a-url')).toBeUndefined();

    expect(stripTokenFromEndpoint('wss://h/worker?token=a.b&x=1')).toBe('wss://h/worker?x=1');
    expect(stripTokenFromEndpoint('wss://h/worker')).toBe('wss://h/worker');
  });
});

describe('connectToServer endpoint 兼容（真实 socket.io 服务端）', () => {
  it('T-P1：旧 endpoint 连接默认 namespace、handshake 无 token（兼容锚点）', async () => {
    const server = await startServer();
    try {
      const socket = connectToServer(server.url(), 'zag_k_legacy');

      openSockets.push(socket);

      await new Promise<void>((resolve, reject) => {
        socket.on('connect', () => resolve());
        socket.on('connect_error', (err) => reject(err));
        setTimeout(() => reject(new Error('connect timeout')), 3000);
      });

      // 原生解析：无 pathname → 默认 namespace `/`
      expect(socket.nsp).toBe('/');
      const handshake = server.handshakes.at(-1);
      expect(handshake?.token).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('T-P2：新 endpoint（`/worker?token=abc`）握手成功，token 经 auth 传递且不进 URL', async () => {
    const server = await startServer();
    try {
      const socket = connectToServer(server.url('/worker?token=abc'), 'ignored-by-cloud');
      openSockets.push(socket);

      await new Promise<void>((resolve, reject) => {
        socket.on('connect', () => resolve());
        socket.on('connect_error', (err) => reject(err));
        setTimeout(() => reject(new Error('connect timeout')), 3000);
      });

      expect(socket.nsp).toBe('/worker');
      const auth = server.auths.at(-1);
      expect(auth?.token).toBe('abc');
      // token 不再经 handshake query / URL 传递
      expect(server.handshakes.at(-1)?.token).toBeUndefined();

      // register 仍照常发送（cloud-controller 侧忽略 key，保持握手兼容）
      await vi.waitFor(() => {
        expect(server.registerPayloads.length).toBeGreaterThan(0);
      });
    } finally {
      await server.close();
    }
  });

  it('T-P3：无 query token 的新 endpoint 用 key 作为握手 auth token（cloud-controller 场景）', async () => {
    const server = await startServer();
    try {
      const socket = connectToServer(server.url('/worker'), 'container-1.secret');
      openSockets.push(socket);

      await new Promise<void>((resolve, reject) => {
        socket.on('connect', () => resolve());
        socket.on('connect_error', (err) => reject(err));
        setTimeout(() => reject(new Error('connect timeout')), 3000);
      });

      expect(socket.nsp).toBe('/worker');
      expect(server.auths.at(-1)?.token).toBe('container-1.secret');
      expect(server.handshakes.at(-1)?.token).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});
