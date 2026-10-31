import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Force the real (unmocked) ACP SDK through the vite pipeline (same rationale
// as acp-wire-mcp.test.ts): keep actual SDK serialization behavior on the wire.
vi.mock('@agentclientprotocol/sdk', async (importOriginal) => {
  return await importOriginal<typeof import('@agentclientprotocol/sdk')>();
});

import { AcpSessionBridge } from '../../src/acp/bridge.js';
import { AcpSpawner } from '../../src/acp/spawner.js';

const FAKE_AGENT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp-agent.mjs');

interface CapturedEntry {
  method: string;
  params?: Record<string, unknown>;
  response?: Record<string, unknown> | null;
}

// Wire-level test: drives a REAL ACP client connection against a fake agent
// process that issues `elicitation/create` (the same wire behavior as an
// eliciting agent such as opencode), and asserts both the Socket.IO payload
// emitted by the bridge and the exact JSON-RPC response that goes back over
// stdio — no mocked ClientSideConnection.
describe('AcpSessionBridge - Elicitation wire format (ACP spec)', () => {
  let workdir: string;
  let captureFile: string;
  let bridge: AcpSessionBridge | null = null;

  afterEach(async () => {
    delete process.env.CAPTURE_FILE;
    delete process.env.FAKE_AGENT_ELICITATION;
    if (bridge) {
      await bridge.stop().catch(() => {});
      bridge = null;
    }
    if (workdir) rmSync(workdir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function setup(mode: 'form' | 'url') {
    workdir = mkdtempSync(join(tmpdir(), 'acp-wire-elic-'));
    captureFile = join(workdir, 'capture.jsonl');
    process.env.CAPTURE_FILE = captureFile;
    process.env.FAKE_AGENT_ELICITATION = mode;
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
    }, spawner);
    return socket;
  }

  function readCapture(): CapturedEntry[] {
    if (!existsSync(captureFile)) return [];
    return readFileSync(captureFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  function emittedCall(socket: { emit: ReturnType<typeof vi.fn> }, event: string) {
    return socket.emit.mock.calls.find((c) => c[0] === event);
  }

  it('should advertise elicitation capabilities in initialize on the wire', async () => {
    setup('form');

    await bridge!.start();

    const init = readCapture().find((e) => e.method === 'initialize');
    expect(init).toBeDefined();
    const capabilities = init!.params!.clientCapabilities as Record<string, unknown>;
    expect(capabilities.elicitation).toEqual({ form: {}, url: {} });
  }, 15000);

  it('should forward form elicitation and respond with spec-compliant payload', async () => {
    const socket = setup('form');

    await bridge!.start();
    bridge!.sendInput({ type: 'text', content: 'please refactor this' });

    // The agent's elicitation/create must surface as an acp:elicitation socket event
    await vi.waitFor(() => {
      expect(emittedCall(socket, 'acp:elicitation')).toBeDefined();
    }, { timeout: 10000 });

    const [, payload] = emittedCall(socket, 'acp:elicitation')!;
    expect(payload.sessionId).toBe('sess-wire');
    expect(payload.mode).toBe('form');
    expect(payload.message).toBe('How should I approach this refactoring?');
    expect(payload.requestedSchema.required).toEqual(['strategy']);
    expect(payload.requestId).toMatch(/^elic_/);

    // Simulate the server returning the user's answer
    bridge!.handleElicitationResponse(payload.requestId, 'accept', { strategy: 'balanced' });

    // The agent must receive a spec-compliant CreateElicitationResponse on the wire
    await vi.waitFor(() => {
      const elicitation = readCapture().find((e) => e.method === 'elicitation/create');
      expect(elicitation?.response).toBeDefined();
    }, { timeout: 10000 });

    const elicitation = readCapture().find((e) => e.method === 'elicitation/create');
    expect(elicitation!.response).toEqual({ action: 'accept', content: { strategy: 'balanced' } });

    // Prompt completes after the elicitation resolves
    await vi.waitFor(() => {
      expect(emittedCall(socket, 'acp:prompt:complete')).toBeDefined();
    }, { timeout: 10000 });
  }, 20000);

  it('should forward url elicitation and relay the completion notification', async () => {
    const socket = setup('url');

    await bridge!.start();
    bridge!.sendInput({ type: 'text', content: 'connect my account' });

    await vi.waitFor(() => {
      expect(emittedCall(socket, 'acp:elicitation')).toBeDefined();
    }, { timeout: 10000 });

    const [, payload] = emittedCall(socket, 'acp:elicitation')!;
    expect(payload.mode).toBe('url');
    expect(payload.elicitationId).toBe('fake-oauth-001');
    expect(payload.url).toBe('https://agent.example.com/connect?elicitationId=fake-oauth-001');
    expect(payload.message).toBe('Please authorize access to your repositories.');

    // User consented to open the URL (accept without content)
    bridge!.handleElicitationResponse(payload.requestId, 'accept');

    await vi.waitFor(() => {
      const elicitation = readCapture().find((e) => e.method === 'elicitation/create');
      expect(elicitation?.response).toBeDefined();
    }, { timeout: 10000 });

    const elicitation = readCapture().find((e) => e.method === 'elicitation/create');
    expect(elicitation!.response).toEqual({ action: 'accept' });

    // The agent's elicitation/complete notification must be forwarded
    await vi.waitFor(() => {
      expect(emittedCall(socket, 'acp:elicitation:complete')).toBeDefined();
    }, { timeout: 10000 });

    const [, completePayload] = emittedCall(socket, 'acp:elicitation:complete')!;
    expect(completePayload).toEqual({ sessionId: 'sess-wire', elicitationId: 'fake-oauth-001' });
  }, 20000);
});
