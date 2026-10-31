import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('readline', () => ({
  createInterface: vi.fn().mockReturnValue({
    on: vi.fn(),
  }),
}));

import { startMcpProxy } from '../../src/commands/mcp.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
  }));
  vi.stubGlobal('process', {
    ...process,
    stdout: { write: vi.fn() },
    exit: vi.fn(),
  });
});

describe('mcp command', () => {
  it('should start stdio proxy with endpoint and token', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const readline = await import('readline');
    const mockRl = {
      on: vi.fn(),
    };
    vi.mocked(readline.createInterface).mockReturnValue(mockRl as never);

    await startMcpProxy({
      endpoint: 'http://localhost:3002/mcp/session-1',
      token: 'test-token',
    });

    expect(readline.createInterface).toHaveBeenCalledWith({ input: process.stdin });
    expect(mockRl.on).toHaveBeenCalledWith('line', expect.any(Function));
    expect(mockRl.on).toHaveBeenCalledWith('close', expect.any(Function));

    // R3：代理端点进度为用户可见输出（保持纯文本 stdout，非 JSON）
    expect(consoleSpy).toHaveBeenCalledWith('Starting MCP proxy for endpoint: http://localhost:3002/mcp/session-1');
    expect(String(consoleSpy.mock.calls[0][0])).not.toMatch(/^\s*\{/);

    consoleSpy.mockRestore();
  });
});
