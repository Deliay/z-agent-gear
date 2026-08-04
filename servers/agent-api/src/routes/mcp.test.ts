import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

vi.mock('jsonwebtoken', () => ({
  default: {
    verify: vi.fn(),
  },
}));

vi.mock('../services/mcp-endpoint.js', () => ({
  mcpEndpointService: {
    getStatus: vi.fn(),
  },
}));

vi.mock('../services/mcp-forwarder.js', () => {
  class ForwardError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'ForwardError';
    }
  }
  return {
    mcpForwarder: {
      request: vi.fn(),
    },
    ForwardError,
  };
});

vi.mock('../models/mcp-server.js', () => ({
  McpServer: {
    findOne: vi.fn(),
  },
}));

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import jwt from 'jsonwebtoken';
import { mcpEndpointService } from '../services/mcp-endpoint.js';
import { mcpForwarder, ForwardError } from '../services/mcp-forwarder.js';
import { McpServer } from '../models/mcp-server.js';
import { getRedisClient } from '../middleware/redis.js';
import { mcpRouter } from './mcp.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/mcp', mcpRouter);
  server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRedisClient).mockReturnValue({ get: vi.fn(), set: vi.fn(), del: vi.fn() } as never);
});

function post(path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return fetch(baseUrl + path, { method: 'POST', headers, body: JSON.stringify(body) });
}

const VALID_PAYLOAD = { sessionId: 'session-1', userId: 'user-1', serverNames: ['github-mcp'] };
const VALID_REQUEST = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search' } };

function mockServerDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'server-1' },
    transport: 'registered_proxy',
    ...overrides,
  };
}

describe('MCP HTTP Entry', () => {
  it('should return 401 when token is missing', async () => {
    const res = await post('/mcp/session-1', VALID_REQUEST);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('ENDPOINT_REVOKED');
    expect(jwt.verify).not.toHaveBeenCalled();
  });

  it('should return 401 when token is invalid', async () => {
    vi.mocked(jwt.verify).mockImplementation(() => { throw new Error('jwt malformed'); });

    const res = await post('/mcp/session-1', VALID_REQUEST, 'bad-token');

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('ENDPOINT_REVOKED');
  });

  it('should return 401 when token sessionId does not match path', async () => {
    vi.mocked(jwt.verify).mockReturnValue({ ...VALID_PAYLOAD, sessionId: 'other-session' } as never);

    const res = await post('/mcp/session-1', VALID_REQUEST, 'valid-token');

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('ENDPOINT_REVOKED');
  });

  it('should return 401 when endpoint is revoked', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('revoked');

    const res = await post('/mcp/session-1', VALID_REQUEST, 'valid-token');

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('ENDPOINT_REVOKED');
  });

  it('should return 400 when jsonrpc is missing', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');

    const res = await post('/mcp/session-1', { id: 1, method: 'tools/call' }, 'valid-token');

    expect(res.status).toBe(400);
  });

  it('should return 400 when method is missing', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');

    const res = await post('/mcp/session-1', { jsonrpc: '2.0', id: 1 }, 'valid-token');

    expect(res.status).toBe(400);
  });

  it('should return 400 when no server name specified', async () => {
    vi.mocked(jwt.verify).mockReturnValue({ sessionId: 'session-1', userId: 'user-1', serverNames: [] } as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');

    const res = await post('/mcp/session-1', VALID_REQUEST, 'valid-token');

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe('No server name specified');
  });

  it('should return 200 JSON-RPC SERVER_NOT_FOUND when server not found', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
    vi.mocked(McpServer.findOne).mockResolvedValue(null as never);

    const res = await post('/mcp/session-1', VALID_REQUEST, 'valid-token');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error.code).toBe('SERVER_NOT_FOUND');
    expect(McpServer.findOne).toHaveBeenCalledWith({
      userId: 'user-1',
      name: 'github-mcp',
      enabled: true,
    });
  });

  it('should return 200 JSON-RPC SERVER_NOT_FOUND for unsupported transport', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
    vi.mocked(McpServer.findOne).mockResolvedValue(mockServerDoc({ transport: 'http' }) as never);

    const res = await post('/mcp/session-1', VALID_REQUEST, 'valid-token');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error.code).toBe('SERVER_NOT_FOUND');
  });

  it('should return 200 JSON-RPC SERVER_OFFLINE when no owner registered', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
    vi.mocked(McpServer.findOne).mockResolvedValue(mockServerDoc() as never);
    vi.mocked(getRedisClient).mockReturnValue({ get: vi.fn().mockResolvedValue(null), set: vi.fn(), del: vi.fn() } as never);

    const res = await post('/mcp/session-1', VALID_REQUEST, 'valid-token');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error.code).toBe('SERVER_OFFLINE');
    expect(mcpForwarder.request).not.toHaveBeenCalled();
  });

  it('should forward request and return the response on success', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
    vi.mocked(McpServer.findOne).mockResolvedValue(mockServerDoc() as never);
    const redis = { get: vi.fn().mockResolvedValue('instance-1'), set: vi.fn(), del: vi.fn() };
    vi.mocked(getRedisClient).mockReturnValue(redis as never);
    const forwardResponse = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'hi' }] } };
    vi.mocked(mcpForwarder.request).mockResolvedValue(forwardResponse as never);

    const res = await post('/mcp/session-1', VALID_REQUEST, 'valid-token');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(forwardResponse);
    expect(redis.get).toHaveBeenCalledWith('mcp:proxy:owner:server-1');
    expect(mcpForwarder.request).toHaveBeenCalledWith({
      serverId: 'server-1',
      sessionId: 'session-1',
      request: VALID_REQUEST,
    });
  });

  it('should return 200 JSON-RPC FORWARD_TIMEOUT on forward timeout', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
    vi.mocked(McpServer.findOne).mockResolvedValue(mockServerDoc() as never);
    vi.mocked(getRedisClient).mockReturnValue({ get: vi.fn().mockResolvedValue('instance-1'), set: vi.fn(), del: vi.fn() } as never);
    vi.mocked(mcpForwarder.request).mockRejectedValue(new ForwardError('FORWARD_TIMEOUT', 'Forward timeout'));

    const res = await post('/mcp/session-1', VALID_REQUEST, 'valid-token');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error.code).toBe('FORWARD_TIMEOUT');
  });

  it('should pass through FORWARD_ERROR code from the forwarder', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
    vi.mocked(McpServer.findOne).mockResolvedValue(mockServerDoc() as never);
    vi.mocked(getRedisClient).mockReturnValue({ get: vi.fn().mockResolvedValue('instance-1'), set: vi.fn(), del: vi.fn() } as never);
    vi.mocked(mcpForwarder.request).mockRejectedValue(new ForwardError('FORWARD_ERROR', 'owner socket gone'));

    const res = await post('/mcp/session-1', VALID_REQUEST, 'valid-token');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error.code).toBe('FORWARD_ERROR');
    expect(body.error.message).toBe('owner socket gone');
  });

  it('should route to the server given in the URL path', async () => {
    vi.mocked(jwt.verify).mockReturnValue({ ...VALID_PAYLOAD, serverNames: ['github-mcp', 'db-mcp'] } as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
    vi.mocked(McpServer.findOne).mockResolvedValue(mockServerDoc() as never);
    vi.mocked(getRedisClient).mockReturnValue({ get: vi.fn().mockResolvedValue('instance-1'), set: vi.fn(), del: vi.fn() } as never);
    vi.mocked(mcpForwarder.request).mockResolvedValue({ jsonrpc: '2.0', id: 1, result: {} } as never);

    const res = await post('/mcp/session-1/db-mcp', VALID_REQUEST, 'valid-token');

    expect(res.status).toBe(200);
    expect(McpServer.findOne).toHaveBeenCalledWith({
      userId: 'user-1',
      name: 'db-mcp',
      enabled: true,
    });
  });

  it('should reject a path server that was not assembled into the session', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');

    const res = await post('/mcp/session-1/other-mcp', VALID_REQUEST, 'valid-token');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error.code).toBe('SERVER_NOT_FOUND');
    expect(McpServer.findOne).not.toHaveBeenCalled();
    expect(mcpForwarder.request).not.toHaveBeenCalled();
  });

  it('should return 200 JSON-RPC FORWARD_ERROR on unexpected forwarder failure', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
    vi.mocked(McpServer.findOne).mockResolvedValue(mockServerDoc() as never);
    vi.mocked(getRedisClient).mockReturnValue({ get: vi.fn().mockResolvedValue('instance-1'), set: vi.fn(), del: vi.fn() } as never);
    vi.mocked(mcpForwarder.request).mockRejectedValue(new Error('unexpected boom'));

    const res = await post('/mcp/session-1', VALID_REQUEST, 'valid-token');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error.code).toBe('FORWARD_ERROR');
    expect(body.error.message).toBe('unexpected boom');
  });
});
