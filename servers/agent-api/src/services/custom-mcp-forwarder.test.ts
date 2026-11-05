import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../models/custom-mcp-server.js', () => ({
  CustomMcpServer: {
    findById: vi.fn(),
  },
}));

vi.mock('./valut-service.js', () => ({
  valutService: {
    resolveValue: vi.fn(),
  },
}));

import { logger as rootLogger } from '../observability/logger.js';
import { createTestLogger } from '../observability/testing.js';
import { CustomMcpServer } from '../models/custom-mcp-server.js';
import { valutService } from './valut-service.js';

/**
 * 注入内存 sink：断言转发链路日志无凭据明文（T-CF5 / D8）。
 * 必须在被测模块加载前拦截 `rootLogger.child(...)`。
 */
const testLog = createTestLogger();
const childSpy = vi
  .spyOn(rootLogger, 'child')
  .mockImplementation((bindings) => testLog.logger.child(bindings));
const { CustomMcpForwarder } = await import('./custom-mcp-forwarder.js');
childSpy.mockRestore();

const MCP_ID = '64b0000000000000000000c1';
const ENTRY_ID = '64b0000000000000000000e1';
const REQUEST = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search' } };

const fetchMock = vi.fn();
const forwarder = new CustomMcpForwarder();

function serverDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: MCP_ID,
    name: 'custom-a',
    endpoint: 'https://mcp.example.com/rpc',
    authType: 'none',
    customHeaders: new Map<string, string[]>(),
    bearerValutEntryId: null,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function forward(entry: { id: string; name: string } = { id: MCP_ID, name: 'custom-a' }) {
  return forwarder.forward({ sessionId: 'sess-1', snapshotEntry: entry, body: REQUEST });
}

beforeEach(() => {
  vi.clearAllMocks();
  testLog.reset();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(CustomMcpServer.findById).mockResolvedValue(serverDoc() as never);
  // 每次调用新建 Response（body 只能读一次，多次转发共用实例会失效）
  fetchMock.mockImplementation(() =>
    Promise.resolve(jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { ok: true } })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('custom-mcp-forwarder', () => {
  it('T-CF3: 自定义 MCP 已删除 → 410（全端点同时失效，不发真实请求）', async () => {
    vi.mocked(CustomMcpServer.findById).mockResolvedValue(null as never);

    const result = await forward();

    expect(CustomMcpServer.findById).toHaveBeenCalledWith(MCP_ID);
    expect(result.status).toBe(410);
    expect(result.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: 'SERVER_NOT_FOUND', message: expect.any(String) },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('T-CF3: 快照 id 非法（防御式）同样 410', async () => {
    const result = await forward({ id: 'not-an-object-id', name: 'custom-a' });

    expect(result.status).toBe(410);
    expect(CustomMcpServer.findById).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('T-CF4: bearer 解密注入 Authorization，customHeaders 同名多值展开', async () => {
    vi.mocked(CustomMcpServer.findById).mockResolvedValue(
      serverDoc({
        authType: 'bearer',
        bearerValutEntryId: ENTRY_ID,
        customHeaders: new Map([['x-multi', ['a', 'b']]]),
      }) as never,
    );
    vi.mocked(valutService.resolveValue).mockResolvedValue('super-secret-token');

    const result = await forward();

    expect(valutService.resolveValue).toHaveBeenCalledWith(ENTRY_ID);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://mcp.example.com/rpc');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(REQUEST));
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers.get('authorization')).toBe('Bearer super-secret-token');
    expect(init.headers.get('x-multi')).toBe('a, b');
    expect(init.headers.get('content-type')).toBe('application/json');
  });

  it('T-CF4: customHeaders plain object 形态同样展开', async () => {
    vi.mocked(CustomMcpServer.findById).mockResolvedValue(
      serverDoc({
        customHeaders: { 'x-plain': ['p1', 'p2'] },
      }) as never,
    );

    await forward();

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.get('x-plain')).toBe('p1, p2');
  });

  it('T-CF4/D8: bearer 条目加载失败按 410 同口径防御式（不发真实请求）', async () => {
    vi.mocked(CustomMcpServer.findById).mockResolvedValue(
      serverDoc({ authType: 'bearer', bearerValutEntryId: ENTRY_ID }) as never,
    );
    vi.mocked(valutService.resolveValue).mockRejectedValue(new Error('valut entry not found'));

    const result = await forward();

    expect(result.status).toBe(410);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('T-CF4: 真实 endpoint 不可达 → 502', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'));

    const result = await forward();

    expect(result.status).toBe(502);
    expect(result.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: 'FORWARD_ERROR', message: expect.any(String) },
    });
  });

  it('T-CF4: 30s 超时（AbortController）→ 502', async () => {
    const shortForwarder = new CustomMcpForwarder(20);
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const err = new Error('This operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    const result = await shortForwarder.forward({
      sessionId: 'sess-1',
      snapshotEntry: { id: MCP_ID, name: 'custom-a' },
      body: REQUEST,
    });

    expect(result.status).toBe(502);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('T-CF6: 配置按 id 每次请求实时加载——endpoint/headers 编辑后新调用即时生效', async () => {
    vi.mocked(CustomMcpServer.findById)
      .mockResolvedValueOnce(
        serverDoc({ endpoint: 'https://old.example.com/rpc', customHeaders: new Map([['x-v', ['1']]]) }) as never,
      )
      .mockResolvedValueOnce(
        serverDoc({ endpoint: 'https://new.example.com/rpc', customHeaders: new Map([['x-v', ['2']]]) }) as never,
      );

    await forward();
    await forward();

    expect(CustomMcpServer.findById).toHaveBeenCalledTimes(2);
    expect(CustomMcpServer.findById).toHaveBeenNthCalledWith(1, MCP_ID);
    expect(fetchMock.mock.calls[0][0]).toBe('https://old.example.com/rpc');
    expect(fetchMock.mock.calls[0][1].headers.get('x-v')).toBe('1');
    expect(fetchMock.mock.calls[1][0]).toBe('https://new.example.com/rpc');
    expect(fetchMock.mock.calls[1][1].headers.get('x-v')).toBe('2');
  });

  it('T-CF6: 快照 name 与当前 name 不一致（已改名）不影响转发', async () => {
    vi.mocked(CustomMcpServer.findById).mockResolvedValue(serverDoc({ name: 'renamed-a' }) as never);

    const result = await forward({ id: MCP_ID, name: 'legacy-name' });

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('T-CF5: 转发日志与错误返回均无凭据明文（Bearer token / 自定义 header 值）', async () => {
    vi.mocked(CustomMcpServer.findById).mockResolvedValue(
      serverDoc({
        authType: 'bearer',
        bearerValutEntryId: ENTRY_ID,
        customHeaders: new Map([['x-api-key', ['header-secret-value']]]),
      }) as never,
    );
    vi.mocked(valutService.resolveValue).mockResolvedValue('super-secret-token');
    // 失败路径：错误信息不得回带 token/header 值，也不得打印真实 endpoint 响应正文
    fetchMock.mockRejectedValue(new Error('connect ETIMEDOUT https://mcp.example.com/rpc'));

    const result = await forward();

    expect(result.status).toBe(502);
    const logs = JSON.stringify(testLog.records);
    expect(logs).not.toContain('super-secret-token');
    expect(logs).not.toContain('header-secret-value');
    expect(JSON.stringify(result.body)).not.toContain('super-secret-token');
    expect(JSON.stringify(result.body)).not.toContain('header-secret-value');
    // 结构化日志：只带 sessionId/mcpId/name/status 等白名单字段
    expect(testLog.records.length).toBeGreaterThan(0);
    for (const record of testLog.records) {
      expect(Object.keys(record)).not.toContain('headers');
      expect(Object.keys(record)).not.toContain('authorization');
    }
  });

  it('T-CF5: 成功路径不记录真实 endpoint 响应正文（即使回显凭据也只回传不落日志）', async () => {
    vi.mocked(CustomMcpServer.findById).mockResolvedValue(
      serverDoc({ authType: 'bearer', bearerValutEntryId: ENTRY_ID }) as never,
    );
    vi.mocked(valutService.resolveValue).mockResolvedValue('super-secret-token');
    fetchMock.mockResolvedValue(
      jsonResponse(200, { jsonrpc: '2.0', id: 1, result: { echo: 'Bearer super-secret-token' } }),
    );

    const result = await forward();

    expect(result.status).toBe(200);
    expect(JSON.stringify(testLog.records)).not.toContain('super-secret-token');
    expect(JSON.stringify(testLog.records)).not.toContain('mcp.example.com');
    // 响应体按契约回传给调用方（回显由上游负责，服务端不改写）
    expect(JSON.stringify(result.body)).toContain('super-secret-token');
  });
});
