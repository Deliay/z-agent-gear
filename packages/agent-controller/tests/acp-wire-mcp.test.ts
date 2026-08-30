import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Force the real (unmocked) ACP SDK through the vite pipeline: returning the
// original module keeps actual SDK serialization behavior while avoiding the
// node-native externalization that breaks .js -> .ts source resolution.
vi.mock('@agentclientprotocol/sdk', async (importOriginal) => {
  return await importOriginal<typeof import('@agentclientprotocol/sdk')>();
});

import { AcpSessionBridge } from '../../src/acp/bridge.js';
import { AcpSpawner } from '../../src/acp/spawner.js';

const FAKE_AGENT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp-agent.mjs');

// Wire-level test: drives a REAL ACP client connection (SDK serialization,
// ndJsonStream) against a fake agent process, and asserts the exact JSON-RPC
// payload that goes over stdin — no mocked ClientSideConnection.
describe('AcpSessionBridge - MCP wire format (ACP spec)', () => {
  let workdir: string;
  let captureFile: string;
  let bridge: AcpSessionBridge | null = null;

  afterEach(async () => {
    delete process.env.CAPTURE_FILE;
    if (bridge) {
      await bridge.stop().catch(() => {});
      bridge = null;
    }
    if (workdir) rmSync(workdir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function setup() {
    workdir = mkdtempSync(join(tmpdir(), 'acp-wire-'));
    captureFile = join(workdir, 'capture.jsonl');
    process.env.CAPTURE_FILE = captureFile;
    const spawner = new AcpSpawner({
      sessionId: 'sess-wire',
      cwd: workdir,
      command: process.execPath,
      args: [FAKE_AGENT],
    });
    const socket = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
    bridge = new AcpSessionBridge(socket as never, {
      sessionId: 'sess-wire',
      cwd: workdir,
      mcpEndpoint: {
        token: 'wire-token',
        serverNames: ['fluentui-mcp', 'fs-mcp'],
      },
      mcpPort: 41234,
    }, spawner);
    return socket;
  }

  function readCapture(): Array<{ method: string; params: Record<string, unknown> }> {
    return readFileSync(captureFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  }

  it('should send session/new with spec-compliant mcpServers on the wire', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setup();

    await bridge!.start();

    const captured = readCapture();
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe('session/new');
    // ACP spec (session/new): mcpServers entries for HTTP transport are
    // { type: "http", name, url, headers: [{ name, value }] }
    expect(captured[0].params.mcpServers).toEqual([
      {
        type: 'http',
        name: 'fluentui-mcp',
        url: 'http://127.0.0.1:41234/mcp/sess-wire/fluentui-mcp',
        headers: [{ name: 'Authorization', value: 'Bearer wire-token' }],
      },
      {
        type: 'http',
        name: 'fs-mcp',
        url: 'http://127.0.0.1:41234/mcp/sess-wire/fs-mcp',
        headers: [{ name: 'Authorization', value: 'Bearer wire-token' }],
      },
    ]);
    expect(captured[0].params.cwd).toBe(workdir);

    // The MCP handoff must be visible in logs, without leaking the token
    const logLines = logSpy.mock.calls.map((c) => String(c[0]));
    const mcpLog = logLines.find((l) => l.includes('passing MCP servers via session/new'));
    expect(mcpLog).toBeDefined();
    expect(mcpLog).toContain('fluentui-mcp(type=http, url=http://127.0.0.1:41234/mcp/sess-wire/fluentui-mcp, headers=Authorization)');
    expect(mcpLog).not.toContain('wire-token');
  }, 15000);

  it('should send session/resume with spec-compliant mcpServers on the wire', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    setup();

    await bridge!.resume('ext-session-1');

    const captured = readCapture();
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe('session/resume');
    expect(captured[0].params.sessionId).toBe('ext-session-1');
    expect(captured[0].params.mcpServers).toEqual([
      expect.objectContaining({ type: 'http', name: 'fluentui-mcp' }),
      expect.objectContaining({ type: 'http', name: 'fs-mcp' }),
    ]);
  }, 15000);
});
