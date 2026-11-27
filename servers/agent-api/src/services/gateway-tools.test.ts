import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/mcp-server.js', () => ({
  McpServer: {
    findOneAndUpdate: vi.fn(),
    findOne: vi.fn(),
  },
}));

vi.mock('../models/session.js', () => ({
  Session: {
    findById: vi.fn(),
  },
}));

vi.mock('./gateway.js', () => ({
  gatewayService: {
    findAllByController: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
}));

import {
  GATEWAY_TOOLS_SERVER_NAME,
  GATEWAY_TOOL_DEFINITIONS,
  handleGatewayToolsMcpRequest,
  ensureGatewayToolsServer,
} from './gateway-tools.js';
import { McpServer } from '../models/mcp-server.js';
import { Session } from '../models/session.js';
import { gatewayService } from './gateway.js';

const CALLER = { userId: 'user1', sessionId: 'sess1' };

function mockSessionController(controllerId: string | null) {
  vi.mocked(Session.findById).mockReturnValue({
    select: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(controllerId ? { controllerId } : null),
  } as never);
}

function toolText(result: { result?: unknown }): { code?: string; message?: string } {
  const content = (result.result as { content: { text: string }[] }).content;
  return JSON.parse(content[0].text);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('agent-gateway-tools MCP handler', () => {
  it('T-GT1: initialize 声明 tools + resources（无 prompts）', async () => {
    const result = await handleGatewayToolsMcpRequest(CALLER, { method: 'initialize' });
    const payload = result.result as {
      capabilities: Record<string, unknown>;
      serverInfo: { name: string };
    };
    expect(payload.serverInfo.name).toBe(GATEWAY_TOOLS_SERVER_NAME);
    expect(payload.capabilities).toHaveProperty('tools');
    expect(payload.capabilities).toHaveProperty('resources');
    expect(payload.capabilities).not.toHaveProperty('prompts');
  });

  it('T-GT2: tools/list 返回三工具，description 含发现引导与「仅在用户要求」约束', async () => {
    const result = await handleGatewayToolsMcpRequest(CALLER, { method: 'tools/list' });
    const tools = (result.result as { tools: typeof GATEWAY_TOOL_DEFINITIONS }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      'gateway_list',
      'gateway_create_endpoint',
      'gateway_delete_endpoint',
    ]);
    for (const tool of tools) {
      expect(tool.description).toContain(
        'zag://agent-gateway-tools/prompt/gateway-exposure-guidance',
      );
    }
    expect(tools[1].description).toContain('仅在用户要求暴露服务时使用');
  });

  it('T-GT3: gateway_create_endpoint 由会话解析控制器并返回 endpoint/basePath', async () => {
    mockSessionController('ctrl1');
    vi.mocked(gatewayService.create).mockResolvedValue({
      id: 'gw1',
      controllerId: 'ctrl1',
      name: 'my-service',
      port: 5173,
      status: 'active',
      endpoint: 'http://localhost:10001/api/gateway/ctrl1/my-service/',
    });

    const result = await handleGatewayToolsMcpRequest(CALLER, {
      method: 'tools/call',
      params: { name: 'gateway_create_endpoint', arguments: { name: 'my-service', port: 5173 } },
    });

    expect(gatewayService.create).toHaveBeenCalledWith('ctrl1', 'user1', 'my-service', 5173, 5);
    expect(toolText(result)).toEqual({
      name: 'my-service',
      port: 5173,
      status: 'active',
      endpoint: 'http://localhost:10001/api/gateway/ctrl1/my-service/',
      basePath: '/api/gateway/ctrl1/my-service/',
    });
    expect((result.result as { isError?: boolean }).isError).toBeUndefined();
  });

  it('T-GT4: gateway_list 返回列表与每控制器上限 limit', async () => {
    mockSessionController('ctrl1');
    vi.mocked(gatewayService.findAllByController).mockResolvedValue({
      gateways: [
        {
          id: 'gw1',
          controllerId: 'ctrl1',
          name: 'my-service',
          port: 5173,
          status: 'active',
          endpoint: 'http://localhost:10001/api/gateway/ctrl1/my-service/',
        },
      ],
      total: 1,
      limit: 0,
    });

    const result = await handleGatewayToolsMcpRequest(CALLER, {
      method: 'tools/call',
      params: { name: 'gateway_list', arguments: {} },
    });

    expect(toolText(result)).toEqual({
      gateways: [
        {
          name: 'my-service',
          port: 5173,
          status: 'active',
          endpoint: 'http://localhost:10001/api/gateway/ctrl1/my-service/',
          basePath: '/api/gateway/ctrl1/my-service/',
        },
      ],
      limit: 5,
    });
  });

  it('T-GT5: 入参缺失/非法返回 INVALID_PARAMS（附字段规则），不调用服务', async () => {
    mockSessionController('ctrl1');

    const missingName = await handleGatewayToolsMcpRequest(CALLER, {
      method: 'tools/call',
      params: { name: 'gateway_create_endpoint', arguments: { port: 5173 } },
    });
    expect(toolText(missingName).code).toBe('INVALID_PARAMS');
    expect(toolText(missingName).message).toContain('name');

    const badPort = await handleGatewayToolsMcpRequest(CALLER, {
      method: 'tools/call',
      params: { name: 'gateway_create_endpoint', arguments: { name: 'svc', port: 0 } },
    });
    expect(toolText(badPort).code).toBe('INVALID_PARAMS');
    expect(toolText(badPort).message).toContain('port');

    expect(gatewayService.create).not.toHaveBeenCalled();
  });

  it('T-GT6: 服务白名单错误逐字透传（isError），未命中收敛 internal error', async () => {
    mockSessionController('ctrl1');
    vi.mocked(gatewayService.create).mockRejectedValueOnce(
      new Error('Name length must be 1-50 characters'),
    );
    const named = await handleGatewayToolsMcpRequest(CALLER, {
      method: 'tools/call',
      params: { name: 'gateway_create_endpoint', arguments: { name: 'a', port: 3000 } },
    });
    expect(toolText(named).message).toBe('Name length must be 1-50 characters');
    expect((named.result as { isError?: boolean }).isError).toBe(true);

    vi.mocked(gatewayService.create).mockRejectedValueOnce(new Error('boom'));
    const unknown = await handleGatewayToolsMcpRequest(CALLER, {
      method: 'tools/call',
      params: { name: 'gateway_create_endpoint', arguments: { name: 'a', port: 3000 } },
    });
    expect(toolText(unknown).message).toBe('internal error');
  });

  it('T-GT7: gateway_delete_endpoint 未命中返回 Gateway not found or not active，成功返回 deleted', async () => {
    mockSessionController('ctrl1');
    vi.mocked(gatewayService.delete).mockResolvedValueOnce(false);
    const miss = await handleGatewayToolsMcpRequest(CALLER, {
      method: 'tools/call',
      params: { name: 'gateway_delete_endpoint', arguments: { name: 'nope' } },
    });
    expect(toolText(miss).message).toBe('Gateway not found or not active');
    expect((miss.result as { isError?: boolean }).isError).toBe(true);

    vi.mocked(gatewayService.delete).mockResolvedValueOnce(true);
    const ok = await handleGatewayToolsMcpRequest(CALLER, {
      method: 'tools/call',
      params: { name: 'gateway_delete_endpoint', arguments: { name: 'svc' } },
    });
    expect(toolText(ok)).toEqual({ deleted: true });
  });

  it('T-GT8: 控制器缺失 / 资源未知 / 未知工具 / 未知方法 的错误形态', async () => {
    mockSessionController(null);
    const noController = await handleGatewayToolsMcpRequest(CALLER, {
      method: 'tools/call',
      params: { name: 'gateway_list', arguments: {} },
    });
    expect(toolText(noController).message).toBe('Controller not found');

    const list = await handleGatewayToolsMcpRequest(CALLER, { method: 'resources/list' });
    const resources = (list.result as { resources: { uri: string; name: string }[] }).resources;
    expect(resources).toEqual([
      expect.objectContaining({
        uri: 'zag://agent-gateway-tools/prompt/gateway-exposure-guidance',
        name: 'gateway-exposure-guidance',
      }),
    ]);

    const read = await handleGatewayToolsMcpRequest(CALLER, {
      method: 'resources/read',
      params: { uri: 'zag://agent-gateway-tools/prompt/gateway-exposure-guidance' },
    });
    const contents = (read.result as { contents: { mimeType: string; text: string }[] }).contents;
    expect(contents[0].mimeType).toBe('text/markdown');
    expect(contents[0].text).toContain('vite');

    const unknownUri = await handleGatewayToolsMcpRequest(CALLER, {
      method: 'resources/read',
      params: { uri: 'zag://agent-gateway-tools/prompt/nope' },
    });
    expect(unknownUri.error?.code).toBe('INVALID_PARAMS');
    expect(unknownUri.error?.message).toContain('gateway-exposure-guidance');

    const unknownTool = await handleGatewayToolsMcpRequest(CALLER, {
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    });
    expect(unknownTool.error?.code).toBe('METHOD_NOT_FOUND');

    const unknownMethod = await handleGatewayToolsMcpRequest(CALLER, { method: 'prompts/list' });
    expect(unknownMethod.error?.code).toBe('METHOD_NOT_FOUND');
  });

  it('T-GMCP-REPRO-2: 平台 MCP 网关工具 handler 存在且可调用', () => {
    expect(GATEWAY_TOOLS_SERVER_NAME).toBe('agent-gateway-tools');
    expect(typeof handleGatewayToolsMcpRequest).toBe('function');
  });
});

describe('ensureGatewayToolsServer', () => {
  it('upsert platform 服务（transport/source=platform，enabled）', async () => {
    vi.mocked(McpServer.findOneAndUpdate).mockResolvedValue({
      _id: { toString: () => 'mcp-gw' },
    } as never);

    await expect(ensureGatewayToolsServer('user1')).resolves.toBe('mcp-gw');
    expect(McpServer.findOneAndUpdate).toHaveBeenCalledWith(
      { userId: 'user1', name: 'agent-gateway-tools' },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          userId: 'user1',
          name: 'agent-gateway-tools',
          transport: 'platform',
          source: 'platform',
          enabled: true,
        }),
      }),
      { upsert: true, returnDocument: 'after' },
    );
  });
});
