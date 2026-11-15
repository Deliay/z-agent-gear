import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./valut-service.js', () => ({
  valutService: {
    listManualOptions: vi.fn(),
  },
  MANUAL_NAMESPACE: 'manual',
}));

vi.mock('../models/mcp-server.js', () => ({
  McpServer: { findOneAndUpdate: vi.fn(), findOne: vi.fn() },
}));

import { valutService } from './valut-service.js';
import {
  ensureValutToolsServer,
  handleValutToolsMcpRequest,
  VALUT_TOOLS_SERVER_NAME,
} from './valut-tools.js';
import { McpServer } from '../models/mcp-server.js';

const caller = { userId: 'u1', sessionId: 's1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('valut-tools（T-VAL1 / T-VAL2）', () => {
  it('T-VAL1：tools/list 有且仅有 valut_list', async () => {
    const out = await handleValutToolsMcpRequest(caller, { method: 'tools/list' });
    const tools = (out.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(['valut_list']);
    expect(VALUT_TOOLS_SERVER_NAME).toBe('agent-valut-tools');
  });

  it('T-VAL1：valut_list 返回仅名称（无 id/值/refs），仅 manual 口径由服务层保证', async () => {
    vi.mocked(valutService.listManualOptions).mockResolvedValue([
      {
        id: 'entry-id',
        namespace: 'manual',
        namespaceDisplayName: '自定义密钥',
        key: 'API_TOKEN',
        editable: true,
        deletable: true,
        refs: [{ feature: 'x', refId: 'y', refLabel: null, createdAt: new Date().toISOString() }],
        createdBy: 'u1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ] as never);

    const out = await handleValutToolsMcpRequest(caller, {
      method: 'tools/call',
      params: { name: 'valut_list', arguments: {} },
    });
    const text = (out.result as { content: Array<{ text: string }> }).content[0].text;
    expect(JSON.parse(text)).toEqual([{ key: 'API_TOKEN', namespaceDisplayName: '自定义密钥' }]);
    expect(text).not.toContain('entry-id');
    expect(text).not.toContain('refs');
  });

  it('T-VAL2：任意取值工具名 → METHOD_NOT_FOUND（不存在取值工具）', async () => {
    for (const name of ['valut_get', 'valut_value', 'valut_reveal']) {
      const out = await handleValutToolsMcpRequest(caller, {
        method: 'tools/call',
        params: { name, arguments: { key: 'API_TOKEN' } },
      });
      expect(out.error).toMatchObject({ code: 'METHOD_NOT_FOUND' });
    }
  });

  it('initialize / ping / 通知形态', async () => {
    await expect(
      handleValutToolsMcpRequest(caller, { method: 'initialize' }),
    ).resolves.toMatchObject({
      result: { serverInfo: { name: VALUT_TOOLS_SERVER_NAME } },
    });
    await expect(handleValutToolsMcpRequest(caller, { method: 'ping' })).resolves.toEqual({
      result: {},
    });
    await expect(
      handleValutToolsMcpRequest(caller, { method: 'notifications/initialized' }),
    ).resolves.toEqual({ result: {} });
  });

  it('ensureValutToolsServer 幂等 upsert（platform 快照 valut_list）', async () => {
    vi.mocked(McpServer.findOneAndUpdate).mockResolvedValue({ _id: { toString: () => 'id-1' } } as never);
    await expect(ensureValutToolsServer('u1')).resolves.toBe('id-1');
    expect(McpServer.findOneAndUpdate).toHaveBeenCalledWith(
      { userId: 'u1', name: VALUT_TOOLS_SERVER_NAME },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          transport: 'platform',
          source: 'platform',
          enabled: true,
          tools: [{ name: 'valut_list', description: expect.any(String) }],
        }),
      }),
      { upsert: true, returnDocument: 'after' },
    );
  });
});
