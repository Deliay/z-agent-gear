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

vi.mock('../models/mcp-session-endpoint.js', () => ({
  McpSessionEndpoint: {
    findOne: vi.fn(),
  },
}));

vi.mock('./custom-mcp-forwarder.js', () => ({
  customMcpForwarder: {
    forward: vi.fn(),
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
import { McpSessionEndpoint } from '../models/mcp-session-endpoint.js';
import { customMcpForwarder } from './custom-mcp-forwarder.js';
import { getRedisClient } from '../middleware/redis.js';
import { handlePlatformMcpRequest } from './workflow/tool-handlers.js';
import { logger as rootLogger } from '../observability/logger.js';
import { dispatch } from './mcp-dispatch.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRedisClient).mockReturnValue({ get: vi.fn(), set: vi.fn(), del: vi.fn() } as never);
  // 缺省无 custom 快照：既有路径零变化
  vi.mocked(McpSessionEndpoint.findOne).mockReturnValue({
    lean: vi.fn().mockResolvedValue({ sessionId: 'session-1', customMcpServers: [] }),
  } as never);
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

  describe('custom MCP 分流（F3/D1/D6/D7）', () => {
    function mockSnapshot(entries: Array<{ id: string; name: string }> | null) {
      vi.mocked(McpSessionEndpoint.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(
          entries === null ? null : { sessionId: 'session-1', customMcpServers: entries },
        ),
      } as never);
    }

    it('快照 name 命中 → custom-mcp-forwarder，优先于同名个人 MCP（不再查 mcpservers）', async () => {
      vi.mocked(jwt.verify).mockReturnValue({
        sessionId: 'session-1',
        userId: 'user-1',
        serverNames: ['shared-mcp'],
      } as never);
      vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
      mockSnapshot([{ id: '64b0000000000000000000c1', name: 'shared-mcp' }]);
      const forwardResult = {
        status: 200,
        body: { jsonrpc: '2.0', id: 1, result: { ok: true } },
      };
      vi.mocked(customMcpForwarder.forward).mockResolvedValue(forwardResult as never);

      const result = await dispatch({
        sessionId: 'session-1',
        serverName: 'shared-mcp',
        token: 'valid-token',
        body: VALID_REQUEST,
      });

      expect(McpSessionEndpoint.findOne).toHaveBeenCalledWith({ sessionId: 'session-1' });
      expect(customMcpForwarder.forward).toHaveBeenCalledWith({
        sessionId: 'session-1',
        snapshotEntry: { id: '64b0000000000000000000c1', name: 'shared-mcp' },
        body: VALID_REQUEST,
      });
      expect(McpServer.findOne).not.toHaveBeenCalled();
      expect(mcpForwarder.request).not.toHaveBeenCalled();
      expect(result).toEqual(forwardResult);
    });

    it('快照未命中 → 既有 mcpservers 路径零变化', async () => {
      vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
      vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
      mockSnapshot([{ id: '64b0000000000000000000c1', name: 'custom-a' }]);
      vi.mocked(McpServer.findOne).mockResolvedValue(null as never);

      const result = await dispatch({
        sessionId: 'session-1',
        token: 'valid-token',
        body: VALID_REQUEST,
      });

      expect(customMcpForwarder.forward).not.toHaveBeenCalled();
      expect(McpServer.findOne).toHaveBeenCalledWith({
        userId: 'user-1',
        name: 'github-mcp',
        enabled: true,
      });
      expect(result.status).toBe(200);
      expect(jsonRpcErrorBody(result).error.code).toBe('SERVER_NOT_FOUND');
    });

    it('T-CF6: 路由用快照 name、加载用快照 id（改名不影响存量会话路由）', async () => {
      vi.mocked(jwt.verify).mockReturnValue({
        sessionId: 'session-1',
        userId: 'user-1',
        serverNames: ['legacy-name'],
      } as never);
      vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
      // 快照存的是签发期 name；当前 custommcpservers.name 已改为别的名字
      mockSnapshot([{ id: '64b0000000000000000000c1', name: 'legacy-name' }]);
      vi.mocked(customMcpForwarder.forward).mockResolvedValue({ status: 200, body: {} } as never);

      await dispatch({
        sessionId: 'session-1',
        serverName: 'legacy-name',
        token: 'valid-token',
        body: VALID_REQUEST,
      });

      expect(customMcpForwarder.forward).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshotEntry: { id: '64b0000000000000000000c1', name: 'legacy-name' },
        }),
      );
      expect(McpServer.findOne).not.toHaveBeenCalled();
    });

    it('T-CF3: 转发状态原样透传（自定义 MCP 已删除 → 410）', async () => {
      vi.mocked(jwt.verify).mockReturnValue({
        sessionId: 'session-1',
        userId: 'user-1',
        serverNames: ['custom-a'],
      } as never);
      vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
      mockSnapshot([{ id: '64b0000000000000000000c1', name: 'custom-a' }]);
      vi.mocked(customMcpForwarder.forward).mockResolvedValue({
        status: 410,
        body: { jsonrpc: '2.0', id: 1, error: { code: 'SERVER_NOT_FOUND', message: 'gone' } },
      } as never);

      const result = await dispatch({
        sessionId: 'session-1',
        serverName: 'custom-a',
        token: 'valid-token',
        body: VALID_REQUEST,
      });

      expect(result.status).toBe(410);
      expect(jsonRpcErrorBody(result).error.code).toBe('SERVER_NOT_FOUND');
    });

    it('D7: 通知（无 id）立即 202 且 fire-and-forget，转发失败仅 warn', async () => {
      vi.mocked(jwt.verify).mockReturnValue({
        sessionId: 'session-1',
        userId: 'user-1',
        serverNames: ['custom-a'],
      } as never);
      vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
      mockSnapshot([{ id: '64b0000000000000000000c1', name: 'custom-a' }]);
      // 通知的转发链路永不 resolve——入口不得等待
      vi.mocked(customMcpForwarder.forward).mockReturnValue(new Promise(() => {}) as never);
      const warnSpy = vi.spyOn(rootLogger, 'warn');
      const notification = { jsonrpc: '2.0', method: 'notifications/initialized' };

      const start = Date.now();
      const result = await dispatch({
        sessionId: 'session-1',
        serverName: 'custom-a',
        token: 'valid-token',
        body: notification,
      });

      expect(Date.now() - start).toBeLessThan(5000);
      expect(result.status).toBe(202);
      expect(result.body).toBeUndefined();
      expect(customMcpForwarder.forward).toHaveBeenCalledWith({
        sessionId: 'session-1',
        snapshotEntry: { id: '64b0000000000000000000c1', name: 'custom-a' },
        body: notification,
      });

      // 后台失败：仅 warn，不影响 202 响应
      vi.mocked(customMcpForwarder.forward).mockRejectedValue(new Error('upstream boom'));
      const second = await dispatch({
        sessionId: 'session-1',
        serverName: 'custom-a',
        token: 'valid-token',
        body: notification,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(second.status).toBe(202);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'custom-notification-forward-failed' }),
        expect.any(String),
      );
      warnSpy.mockRestore();
    });

    it('401（会话终态）在读快照之前返回，D6 诊断优先级 401 最高', async () => {
      vi.mocked(jwt.verify).mockReturnValue({
        sessionId: 'session-1',
        userId: 'user-1',
        serverNames: ['custom-a'],
      } as never);
      vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('revoked');

      const result = await dispatch({
        sessionId: 'session-1',
        serverName: 'custom-a',
        token: 'valid-token',
        body: VALID_REQUEST,
      });

      expect(result.status).toBe(401);
      expect(McpSessionEndpoint.findOne).not.toHaveBeenCalled();
      expect(customMcpForwarder.forward).not.toHaveBeenCalled();
    });

    it('无 custom 快照的存量会话（字段缺失）不进入分流', async () => {
      vi.mocked(jwt.verify).mockReturnValue(VALID_PAYLOAD as never);
      vi.mocked(mcpEndpointService.getStatus).mockResolvedValue('active');
      vi.mocked(McpSessionEndpoint.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      } as never);
      vi.mocked(McpServer.findOne).mockResolvedValue(null as never);

      const result = await dispatch({
        sessionId: 'session-1',
        token: 'valid-token',
        body: VALID_REQUEST,
      });

      expect(customMcpForwarder.forward).not.toHaveBeenCalled();
      expect(McpServer.findOne).toHaveBeenCalled();
      expect(result.status).toBe(200);
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