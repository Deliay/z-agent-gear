import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  spawn: vi.fn().mockReturnValue({
    stdin: { write: vi.fn() },
    stdout: { on: vi.fn(), removeListener: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  }),
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn().mockReturnValue({
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
  }),
}));

vi.mock('readline', () => ({
  createInterface: vi.fn().mockReturnValue({
    on: vi.fn(),
  }),
}));

import { startMcpRegistration } from '../../src/commands/mcp-proxy.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ success: true, proxyId: 'proxy_1', serverId: 'server_1' }),
  }));
  vi.stubGlobal('process', {
    ...process,
    env: { HOSTNAME: 'test-host' },
    on: vi.fn(),
    exit: vi.fn(),
  });
});

describe('mcp-proxy command', () => {
  it('should register with server and spawn child process', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { io } = await import('socket.io-client');
    const childProcess = await import('child_process');

    await startMcpRegistration({
      server: 'http://localhost:4001',
      key: 'mcp_test-key',
      command: 'npx @modelcontextprotocol/server-github',
    });

    expect(fetch).toHaveBeenCalledWith('http://localhost:4001/api/mcp-proxy/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'mcp_test-key',
        hostname: 'test-host',
        command: 'npx @modelcontextprotocol/server-github',
        serverName: '@modelcontextprotocol/server-github',
      }),
    });

    // R3：用户可见进度/结果保持纯文本 stdout（保留输出逐条人工确认，见计划 §4.7）
    const lines = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain('Registering MCP proxy with server http://localhost:4001...');
    expect(lines).toContain('Registered as proxy proxy_1, server server_1');
    expect(lines).toContain('Starting local MCP command: npx @modelcontextprotocol/server-github');

    // socket / 子进程 / 退出路径的用户可见输出同样保持纯文本
    const socketMock = vi.mocked(io).mock.results[0]?.value as { on: ReturnType<typeof vi.fn> };
    const socketHandlers = (event: string) =>
      socketMock.on.mock.calls.filter((c) => c[0] === event).map((c) => c[1] as () => void);
    socketHandlers('connect').forEach((h) => h());
    socketHandlers('proxy:registered').forEach((h) => (h as (d: object) => void)({ proxyId: 'proxy_1', serverId: 'server_1' }));

    const childOn = vi.mocked(childProcess.spawn).mock.results[0]?.value.on as ReturnType<typeof vi.fn>;
    childOn.mock.calls
      .filter((c) => c[0] === 'error')
      .forEach((c) => (c[1] as (e: Error) => void)(new Error('ENOENT')));

    const processOn = (globalThis.process as unknown as { on: ReturnType<typeof vi.fn> }).on;
    const shutdown = processOn.mock.calls.find((c) => c[0] === 'SIGINT')![1] as () => void;
    shutdown();

    const allLines = consoleSpy.mock.calls.map((c) => String(c[0]));
    expect(allLines).toContain('WebSocket connected to proxy namespace');
    expect(allLines).toContain('Registered with proxy namespace, serverId: server_1');
    expect(allLines).toContain('Shutting down MCP proxy...');
    expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to start MCP command:', 'ENOENT');

    // 纯文本（非 JSON）：每个用户可见输出逐行断言
    for (const line of allLines) {
      expect(line).not.toMatch(/^\s*\{/);
    }
    for (const call of consoleErrorSpy.mock.calls) {
      expect(String(call[0])).not.toMatch(/^\s*\{/);
    }

    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('should exit if registration fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ success: false, error: 'Invalid key' }),
    }));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await startMcpRegistration({
      server: 'http://localhost:4001',
      key: 'invalid-key',
      command: 'npx @modelcontextprotocol/server-github',
    });

    expect(processExitSpy).toHaveBeenCalledWith(1);
    // R3：失败结果为用户可见输出（保持纯文本与原文文案）
    expect(consoleErrorSpy).toHaveBeenCalledWith('Registration failed:', 'Invalid key');
    expect(String(consoleErrorSpy.mock.calls[0][0])).not.toMatch(/^\s*\{/);

    consoleErrorSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  it('should use correct option names for CLI parsing', () => {
    // This test verifies that the CLI options are correctly named
    // to avoid conflicts with global options
    const { Command } = require('commander');
    const program = new Command();
    
    program
      .command('mcp-proxy')
      .description('Register a local MCP command as a proxy')
      .requiredOption('--mcp-server <endpoint>', 'Server endpoint URL')
      .requiredOption('--mcp-key <key>', 'MCP Proxy Key')
      .requiredOption('--command <command>', 'Local MCP command to proxy');

    // Verify the command has the correct options
    const cmd = program.commands.find((c: any) => c.name() === 'mcp-proxy');
    expect(cmd).toBeDefined();
    
    const options = cmd.options.map((o: any) => o.long);
    expect(options).toContain('--mcp-server');
    expect(options).toContain('--mcp-key');
    expect(options).toContain('--command');
    
    // Verify these don't conflict with global options
    expect(options).not.toContain('--key');
    expect(options).not.toContain('--server');
  });
});
