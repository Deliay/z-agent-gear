import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./custom-tool-service.js', () => ({
  customToolService: { listForMcp: vi.fn() },
}));
vi.mock('./valut-service.js', () => ({
  valutService: { resolveManualValueByKey: vi.fn() },
}));
vi.mock('./custom-tool-http.js', () => ({
  execute: vi.fn(),
  toHttpToolError: vi.fn((err: unknown) => (err instanceof Error ? err.message : 'request failed')),
  CustomToolHttpError: class extends Error {},
}));
vi.mock('../models/mcp-server.js', () => ({
  McpServer: { findOneAndUpdate: vi.fn(), findOne: vi.fn() },
}));

import { customToolService, type CustomToolMcpEntry } from './custom-tool-service.js';
import { valutService } from './valut-service.js';
import { execute } from './custom-tool-http.js';
import {
  ensureCustomToolsServer,
  findToolByExposedName,
  handleCustomToolsMcpRequest,
  resolveExposedName,
  CUSTOM_TOOLS_SERVER_NAME,
} from './custom-tools-mcp.js';
import { runWithWorkspace, type WorkspaceContext } from './workspace-context.js';

const ctx: WorkspaceContext = {
  id: '507f1f77bcf86cd7994390b1',
  tenantId: '507f1f77bcf86cd7994390a1',
  type: 'normal',
  role: 'admin',
  readOnly: false,
  globalWorkspaceId: '507f1f77bcf86cd7994390b3',
};
const caller = { userId: 'u1', sessionId: 's1' };

function promptTool(overrides: Partial<CustomToolMcpEntry> = {}): CustomToolMcpEntry {
  return {
    id: '507f1f77bcf86cd7994390d1',
    name: '查询天气',
    description: '按城市查询天气',
    type: 'prompt',
    args: [
      { key: 'city', name: '目标城市', description: null },
      { key: 'month', name: '月份', description: 'yyyy-MM' },
    ],
    prompt: [
      { type: 'Plain', value: 'https://foo.bar/', format: 'Generic' },
      { type: 'Parameter', value: 'city', format: 'Generic' },
    ],
    http: null,
    workspaceId: ctx.id,
    createdBy: 'u1',
    ...overrides,
  };
}

const call = (name: string, args: Record<string, unknown> = {}) =>
  runWithWorkspace(ctx, () =>
    handleCustomToolsMcpRequest(caller, { method: 'tools/call', params: { name, arguments: args } }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(valutService.resolveManualValueByKey).mockResolvedValue(null);
});

describe('custom-tools-mcp（T-CTM1~4）', () => {
  it('T-CTM1：动态目录 tools/list 实时反映；空工作区返回空数组', async () => {
    vi.mocked(customToolService.listForMcp).mockResolvedValue([]);
    await expect(customToolService.listForMcp()).resolves.toEqual([]);
    const empty = await runWithWorkspace(ctx, () =>
      handleCustomToolsMcpRequest(caller, { method: 'tools/list' }),
    );
    expect(empty.result).toEqual({ tools: [] });

    vi.mocked(customToolService.listForMcp).mockResolvedValue([promptTool()]);
    const out = await runWithWorkspace(ctx, () =>
      handleCustomToolsMcpRequest(caller, { method: 'tools/list' }),
    );
    const tools = (out.result as { tools: Array<{ name: string; description: string }> }).tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe(`ct-${'507f1f77bcf86cd7994390d1'.slice(-8)}`);
    expect(tools[0].description).toContain('查询天气');
  });

  it('T-CTM2：暴露名映射（安全名原名直用 / 中文名 ct-<id8> / call 双向反解）', () => {
    const safe = { id: 'abcdef1234567890', name: 'weather_query' };
    const unsafe = { id: 'abcdef1234567890', name: '查询天气' };
    expect(resolveExposedName(safe)).toBe('weather_query');
    expect(resolveExposedName(unsafe)).toBe('ct-34567890');
    expect(findToolByExposedName([promptTool({ name: 'weather_query' })], 'weather_query')).toBeTruthy();
    expect(findToolByExposedName([promptTool()], 'ct-994390d1')).toBeTruthy();
    expect(findToolByExposedName([promptTool()], 'nope')).toBeUndefined();
  });

  it('T-CTM3：参数缺失 → INVALID_PARAMS 列缺失 key；params 归一 string', async () => {
    vi.mocked(customToolService.listForMcp).mockResolvedValue([promptTool()]);
    const missing = await call('ct-994390d1', { city: '北京' });
    expect(missing.error).toMatchObject({ code: 'INVALID_PARAMS' });
    expect(missing.error?.message).toContain('month');
    expect(missing.error?.message).not.toContain('city');
  });

  it('T-CTM3：删除后调用 → METHOD_NOT_FOUND', async () => {
    vi.mocked(customToolService.listForMcp).mockResolvedValue([]);
    const out = await call('ct-994390d1', { city: 'x', month: 'y' });
    expect(out.error).toMatchObject({ code: 'METHOD_NOT_FOUND' });
  });

  it('T-CTM4：prompt 渲染返回 text content（参数齐全）', async () => {
    vi.mocked(customToolService.listForMcp).mockResolvedValue([promptTool()]);
    const out = await call('ct-994390d1', { city: '北京', month: '2026-11' });
    expect(out.result).toEqual({
      content: [{ type: 'text', text: 'https://foo.bar/北京' }],
    });
  });

  it('T-CTM4：Valut 取不到 → isError:true 白名单文案，无密钥片段', async () => {
    vi.mocked(customToolService.listForMcp).mockResolvedValue([
      promptTool({ prompt: [{ type: 'Valut', value: 'MISSING', format: 'Generic' }] }),
    ]);
    vi.mocked(valutService.resolveManualValueByKey).mockResolvedValue(null);
    const out = await call('ct-994390d1', { city: 'x', month: 'y' });
    expect(out.result).toEqual({
      content: [{ type: 'text', text: 'valut key not found: MISSING' }],
      isError: true,
    });
  });

  it('http 工具：执行结果包装为 JSON text；错误 → isError', async () => {
    const httpTool = promptTool({
      type: 'http',
      prompt: null,
      http: {
        method: 'GET',
        endpoint: [{ type: 'Plain', value: 'https://x.example.com', format: 'Generic' }],
        insecure: false,
        bodyType: null,
        body: null,
        form: null,
        headers: [],
        queries: [],
      },
    });
    vi.mocked(customToolService.listForMcp).mockResolvedValue([httpTool]);
    vi.mocked(execute).mockResolvedValue({
      status: 200,
      contentType: 'text/plain',
      bodyText: 'ok',
      truncated: false,
    });
    const ok = await call('ct-994390d1', { city: 'x', month: 'y' });
    const text = (ok.result as { content: Array<{ text: string }> }).content[0].text;
    expect(JSON.parse(text)).toMatchObject({ status: 200, bodyText: 'ok' });

    vi.mocked(execute).mockRejectedValue(new Error('request timeout'));
    const failed = await call('ct-994390d1', { city: 'x', month: 'y' });
    expect(failed.result).toMatchObject({ isError: true });
  });

  it('initialize / tools/list 之外的未知方法', async () => {
    const out = await runWithWorkspace(ctx, () =>
      handleCustomToolsMcpRequest(caller, { method: 'resources/list' }),
    );
    expect(out.error).toMatchObject({ code: 'METHOD_NOT_FOUND' });
  });

  it('ensureCustomToolsServer 动态目录占位快照为 []', async () => {
    const { McpServer } = await import('../models/mcp-server.js');
    vi.mocked(McpServer.findOneAndUpdate).mockResolvedValue({
      _id: { toString: () => 'id-2' },
    } as never);
    await expect(ensureCustomToolsServer('u1')).resolves.toBe('id-2');
    expect(McpServer.findOneAndUpdate).toHaveBeenCalledWith(
      { userId: 'u1', name: CUSTOM_TOOLS_SERVER_NAME },
      expect.objectContaining({ $setOnInsert: expect.objectContaining({ tools: [] }) }),
      { upsert: true, returnDocument: 'after' },
    );
  });
});
