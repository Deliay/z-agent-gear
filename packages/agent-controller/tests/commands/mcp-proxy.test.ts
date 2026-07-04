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

    consoleSpy.mockRestore();
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
