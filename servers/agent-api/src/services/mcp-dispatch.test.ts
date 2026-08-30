import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('jsonwebtoken', () => ({
  default: {
    verify: vi.fn(),
  },
}));

vi.mock('./mcp-endpoint.js', () => ({
  mcpEndpointService: {
    getStatus: vi.fn(),
  },
}));

vi.mock('./mcp-forwarder.js', () => {
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

vi.mock('./workflow/tool-handlers.js', () => ({
  handlePlatformMcpRequest: vi.fn(),
  PLATFORM_SERVER_NAME: 'agent-workflow-tools',
}));

vi.mock('./workflow/admin-tools.js', () => ({
  handleAdminPlatformMcpRequest: vi.fn(),
  ADMIN_PLATFORM_SERVER_NAME: 'agent-workflow-admin-tools',
}));

import jwt from 'jsonwebtoken';
import { mcpEndpointService } from './mcp-endpoint.js';
import { mcpForwarder, ForwardError } from './mcp-forwarder.js';
import { McpServer } from '../models/mcp-server.js';
import { getRedisClient } from '../middleware/redis.js';
import { handlePlatformMcpRequest } from './workflow/tool-handlers.js';
import { dispatch } from './mcp-dispatch.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRedisClient).mockReturnValue({ get: vi.fn(), set: vi.fn(), del: vi.fn() } as never);
});

const VALID_PAYLOAD = { sessionId: 'session-1', userId: 'user-1', serverNames: ['github-mcp'] };
const VALID_REQUEST = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search' } };

function mockServerDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'server-1' },
    transport: 'registered_proxy',
    ...overrides,
  };
}

function jsonRpcErrorBody(result: { status: number; body: unknown }) {
  return result.body as { error: { code: string; message: string }; result?: any };
}

describe('MCP Dispatch', () => {
  it('should return 401 when token is missing', async () => {
    const result = await dispatch({ sessionId: 'session-1', body: VALID_REQUEST });

    expect(result.status).toBe(401);
    expect(jsonRpcErrorBody(result).error.code).toBe('ENDPOINT_REVOKED');
    expect(jwt.verify).not.toHaveBeenCalled();
  });

  it('should return 401 when token is invalid', async () => {
    vi.mocked(jwt.verify).mockImplementation(() => { throw new Error('jwt malformed'); });

    const result = await dispatch({ sessionId: 'session-1', token: 'bad-token', body: VALID_REQUEST });

    expect(result.status).toBe(401);
    expect(jsonRpcErrorBody(result).error.code).toBe('ENDPOINT_REVOKED');
  });

  it('should return 401 when token sessionId does not match path', async () => {
    vi.mocked(jwt.verify).mockReturnValue({ ...VALID_PAYLOAD, sessionId: 'other-session' } as never);

    const result = await dispatch({ sessionId: 'session-1', token: 'valid-token', body: VALID_REQUEST });

    expect(result.status).toBe(401);
    expect(jsonRpcErrorBody(result).error.code).toBe('ENDPOINT_REVOKED');
  });

  it('should return 401 when endpoint is revoked', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('revoked');

    const result = await dispatch({ sessionId: 'session-1', token: 'valid-token', body: VALID_REQUEST });

    expect(result.status).toBe(401);
    expect(jsonRpcErrorBody(result).error.code).toBe('ENDPOINT_REVOKED');
  });

  it('should return 400 when jsonrpc is missing', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');

    const result = await dispatch({ sessionId: 'session-1', token: 'valid-token', body: { id: 1, method: 'tools/call' } });

    expect(result.status).toBe(400);
  });

  it('should return 400 when method is missing', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');

    const result = await dispatch({ sessionId: 'session-1', token: 'valid-token', body: { jsonrpc: '2.0', id: 1 } });

    expect(result.status).toBe(400);
  });

  it('should return 400 when no server name specified', async () => {
    vi.mocked(jwt.verify).mockReturnValue({ sessionId: 'session-1', userId: 'user-1', serverNames: [] } as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');

    const result = await dispatch({ sessionId: 'session-1', token: 'valid-token', body: VALID_REQUEST });

    expect(result.status).toBe(400);
    expect(jsonRpcErrorBody(result).error.message).toBe('No server name specified');
  });

  it('should return 200 JSON-RPC SERVER_NOT_FOUND when server not found', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
    vi.mocked(McpServer.findOne).mockResolvedValue(null as never);

    const result = await dispatch({ sessionId: 'session-1', token: 'valid-token', body: VALID_REQUEST });

    expect(result.status).toBe(200);
    expect(jsonRpcErrorBody(result).error.code).toBe('SERVER_NOT_FOUND');
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

    const result = await dispatch({ sessionId: 'session-1', token: 'valid-token', body: VALID_REQUEST });

    expect(result.status).toBe(200);
    expect(jsonRpcErrorBody(result).error.code).toBe('SERVER_NOT_FOUND');
  });

  it('should return 200 JSON-RPC SERVER_OFFLINE when no owner registered', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
    vi.mocked(McpServer.findOne).mockResolvedValue(mockServerDoc() as never);
    vi.mocked(getRedisClient).mockReturnValue({ get: vi.fn().mockResolvedValue(null), set: vi.fn(), del: vi.fn() } as never);

    const result = await dispatch({ sessionId: 'session-1', token: 'valid-token', body: VALID_REQUEST });

    expect(result.status).toBe(200);
    expect(jsonRpcErrorBody(result).error.code).toBe('SERVER_OFFLINE');
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

    const result = await dispatch({ sessionId: 'session-1', token: 'valid-token', body: VALID_REQUEST });

    expect(result.status).toBe(200);
    expect(result.body).toEqual(forwardResponse);
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

    const result = await dispatch({ sessionId: 'session-1', token: 'valid-token', body: VALID_REQUEST });

    expect(result.status).toBe(200);
    expect(jsonRpcErrorBody(result).error.code).toBe('FORWARD_TIMEOUT');
  });

  it('should pass through FORWARD_ERROR code from the forwarder', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
    vi.mocked(McpServer.findOne).mockResolvedValue(mockServerDoc() as never);
    vi.mocked(getRedisClient).mockReturnValue({ get: vi.fn().mockResolvedValue('instance-1'), set: vi.fn(), del: vi.fn() } as never);
    vi.mocked(mcpForwarder.request).mockRejectedValue(new ForwardError('FORWARD_ERROR', 'owner socket gone'));

    const result = await dispatch({ sessionId: 'session-1', token: 'valid-token', body: VALID_REQUEST });

    expect(result.status).toBe(200);
    expect(jsonRpcErrorBody(result).error.code).toBe('FORWARD_ERROR');
    expect(jsonRpcErrorBody(result).error.message).toBe('owner socket gone');
  });

  it('should route to the server given in the URL path', async () => {
    vi.mocked(jwt.verify).mockReturnValue({ ...VALID_PAYLOAD, serverNames: ['github-mcp', 'db-mcp'] } as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
    vi.mocked(McpServer.findOne).mockResolvedValue(mockServerDoc() as never);
    vi.mocked(getRedisClient).mockReturnValue({ get: vi.fn().mockResolvedValue('instance-1'), set: vi.fn(), del: vi.fn() } as never);
    vi.mocked(mcpForwarder.request).mockResolvedValue({ jsonrpc: '2.0', id: 1, result: {} } as never);

    const result = await dispatch({ sessionId: 'session-1', serverName: 'db-mcp', token: 'valid-token', body: VALID_REQUEST });

    expect(result.status).toBe(200);
    expect(McpServer.findOne).toHaveBeenCalledWith({
      userId: 'user-1',
      name: 'db-mcp',
      enabled: true,
    });
  });

  it('should reject a path server that was not assembled into the session', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');

    const result = await dispatch({ sessionId: 'session-1', serverName: 'other-mcp', token: 'valid-token', body: VALID_REQUEST });

    expect(result.status).toBe(200);
    expect(jsonRpcErrorBody(result).error.code).toBe('SERVER_NOT_FOUND');
    expect(McpServer.findOne).not.toHaveBeenCalled();
    expect(mcpForwarder.request).not.toHaveBeenCalled();
  });

  it('should return 200 JSON-RPC FORWARD_ERROR on unexpected forwarder failure', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
    vi.mocked(McpServer.findOne).mockResolvedValue(mockServerDoc() as never);
    vi.mocked(getRedisClient).mockReturnValue({ get: vi.fn().mockResolvedValue('instance-1'), set: vi.fn(), del: vi.fn() } as never);
    vi.mocked(mcpForwarder.request).mockRejectedValue(new Error('unexpected boom'));

    const result = await dispatch({ sessionId: 'session-1', token: 'valid-token', body: VALID_REQUEST });

    expect(result.status).toBe(200);
    expect(jsonRpcErrorBody(result).error.code).toBe('FORWARD_ERROR');
    expect(jsonRpcErrorBody(result).error.message).toBe('unexpected boom');
  });

  it('should answer JSON-RPC notifications with 202 immediately and forward fire-and-forget', async () => {
    vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
    vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
    vi.mocked(McpServer.findOne).mockResolvedValue(mockServerDoc() as never);
    vi.mocked(getRedisClient).mockReturnValue({ get: vi.fn().mockResolvedValue('instance-1'), set: vi.fn(), del: vi.fn() } as never);
    // the forward chain NEVER resolves for a notification (MCP servers do not
    // respond to them) — the entry point must not wait on it
    vi.mocked(mcpForwarder.request).mockReturnValue(new Promise(() => {}) as never);
    const notification = { jsonrpc: '2.0', method: 'notifications/initialized' };

    const start = Date.now();
    const result = await dispatch({ sessionId: 'session-1', token: 'valid-token', body: notification });

    expect(Date.now() - start).toBeLessThan(5000);
    expect(result.status).toBe(202);
    expect(result.body).toBeUndefined();
    // the notification is still delivered to the stdio server (handshake)
    expect(mcpForwarder.request).toHaveBeenCalledWith({
      serverId: 'server-1',
      sessionId: 'session-1',
      request: notification,
    });
  });

  describe('platform server (agent-workflow-tools)', () => {
    const WORKFLOW_PAYLOAD = {
      ...VALID_PAYLOAD,
      serverNames: ['agent-workflow-tools'],
      workflow: { instanceId: 'inst-1', nodeId: 'n2' },
    };

    function mockPlatformServer() {
      vi.mocked(McpServer.findOne).mockResolvedValue(
        mockServerDoc({ name: 'agent-workflow-tools', transport: 'platform', source: 'platform' }) as never,
      );
    }

    it('平台服务不经 Redis 转发，直接分发到本地 handler 并返回 result', async () => {
      vi.mocked(jwt.verify).mockReturnValue(WORKFLOW_PAYLOAD as never);
      vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
      mockPlatformServer();
      vi.mocked(handlePlatformMcpRequest).mockResolvedValue({
        result: { tools: [{ name: 'getCurrentNodeId' }] },
      });

      const result = await dispatch({
        sessionId: 'session-1',
        serverName: 'agent-workflow-tools',
        token: 'valid-token',
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });

      expect(result.status).toBe(200);
      expect(jsonRpcErrorBody(result).result!.tools).toHaveLength(1);
      // 节点作用域透传到 handler
      expect(handlePlatformMcpRequest).toHaveBeenCalledWith(
        { userId: 'user-1', workflow: { instanceId: 'inst-1', nodeId: 'n2' } },
        expect.objectContaining({ method: 'tools/list' }),
      );
      expect(mcpForwarder.request).not.toHaveBeenCalled();
    });

    it('平台服务的协议级 error 以 JSON-RPC error 返回', async () => {
      vi.mocked(jwt.verify).mockReturnValue(WORKFLOW_PAYLOAD as never);
      vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
      mockPlatformServer();
      vi.mocked(handlePlatformMcpRequest).mockResolvedValue({
        error: { code: 'METHOD_NOT_FOUND', message: '不支持的方法：x' },
      });

      const result = await dispatch({
        sessionId: 'session-1',
        serverName: 'agent-workflow-tools',
        token: 'valid-token',
        body: { jsonrpc: '2.0', id: 2, method: 'x' },
      });

      expect(jsonRpcErrorBody(result).error.code).toBe('METHOD_NOT_FOUND');
    });

    it('平台服务的 notification 立即 202', async () => {
      vi.mocked(jwt.verify).mockReturnValue(WORKFLOW_PAYLOAD as never);
      vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
      mockPlatformServer();
      vi.mocked(handlePlatformMcpRequest).mockResolvedValue({ result: {} });

      const result = await dispatch({
        sessionId: 'session-1',
        serverName: 'agent-workflow-tools',
        token: 'valid-token',
        body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      });

      expect(result.status).toBe(202);
    });

    it('S3: 会话结束后（endpoint 吊销）调用平台工具返回 401', async () => {
      vi.mocked(jwt.verify).mockReturnValue(WORKFLOW_PAYLOAD as never);
      vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('revoked');

      const result = await dispatch({
        sessionId: 'session-1',
        serverName: 'agent-workflow-tools',
        token: 'valid-token',
        body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getCurrentNodeId' } },
      });

      expect(result.status).toBe(401);
      expect(handlePlatformMcpRequest).not.toHaveBeenCalled();
    });
  });
});