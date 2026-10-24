import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { io as SocketIOClient, type Socket as ClientSocket } from 'socket.io-client';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import http, { type Server } from 'node:http';

// End-to-end MCP passthrough verification against REAL services:
//   1. The MCP endpoint handed to the agent via ACP conforms to the new
//      contract ({token, serverNames}, no public url) and the relay chain works
//      (initialize/tools/list/tools/call), with JSON-RPC notifications answered
//      immediately (202) instead of stalling for the forward timeout.
//   2. A real opencode agent, given the loopback relay URL via ACP session/new
//      (exactly like the agent-controller bridge does), actually registers the
//      MCP server and can call its tool. If the tool is missing the agent is
//      asked to print TOOL_MISSING so failures are diagnosable.
//
// Requires: agent-api + controller-api + redis + mongo running (aspire),
// the `opencode` binary, and network access for the agent's model.

const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';

const CONTROLLER_PKG = resolve(__dirname, '../../../../packages/agent-controller');
const MCP_FIXTURE = resolve(__dirname, '../../fixtures/mock-mcp-stdio.mjs');

const MCP_SERVER_NAME = 'mock-mcp-server';
const MARKER = 'MCP_TOOL_OK:mock-mcp-passthrough';
const TOOL_NAME = 'resolve_mock_endpoint';

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(AGENT_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
}

function commandExists(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

interface ChainContext {
  token: string;
  userId: string;
  controllerId: string;
  controllerSocket: ClientSocket;
  proxyProcess: ChildProcess;
  proxyLog: () => string;
  binDir: string;
  sessionId: string;
  mcpEndpoint: { url?: string; token: string; serverNames: string[] };
  serverName: string;
}

async function waitForOutput(proc: ChildProcess, pattern: RegExp, timeoutMs: number, label: string): Promise<void> {
  let output = '';
  const onData = (data: Buffer) => { output += data.toString(); };
  proc.stdout?.on('data', onData);
  proc.stderr?.on('data', onData);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pattern.test(output)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timeout waiting for "${label}" in process output. Got:\n${output}`);
}

// Set up the full real chain: fresh user, real mcp-proxy process (spawned via
// the same tsx entry a user runs) wrapping the deterministic mock MCP command,
// a fake controller to capture acp:start, and a session created with the MCP
// server selected.
async function setupChain(): Promise<ChainContext> {
  const signupRes = await gqlRequest(
    `mutation Signup($username: String!, $password: String!) { signup(username: $username, password: $password) { token user { id } } }`,
    { username: `mcppt${Date.now().toString(36)}`, password: 'testpass123' },
  );
  const signup = await signupRes.json();
  const token = signup.data.signup.token as string;
  const userId = signup.data.signup.user.id as string;

  const keyRes = await fetch(`${CONTROLLER_API_URL}/api/mcp-proxy-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
    body: JSON.stringify({ name: `mcppt-key-${Date.now()}` }),
  });
  const { rawKey: mcpRawKey } = await keyRes.json();
  expect(mcpRawKey).toBeTruthy();

  // Expose the mock MCP command as a bare command name (like fluentui-mcp):
  // the mcp-proxy CLI derives serverName from the command's last token.
  const binDir = mkdtempSync(join(tmpdir(), 'mcppt-bin-'));
  const wrapper = join(binDir, MCP_SERVER_NAME);
  writeFileSync(wrapper, `#!/bin/sh\nexec node "${MCP_FIXTURE}"\n`);
  chmodSync(wrapper, 0o755);

  let proxyLogText = '';
  const proxyProcess = spawn(
    'npx',
    ['tsx', 'src/index.ts', 'mcp-proxy', '--mcp-server', CONTROLLER_API_URL, '--mcp-key', mcpRawKey, '--command', MCP_SERVER_NAME],
    {
      cwd: CONTROLLER_PKG,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, NODE_OPTIONS: '--import tsx' },
    },
  );
  proxyProcess.stdout?.on('data', (d: Buffer) => { proxyLogText += d.toString(); });
  proxyProcess.stderr?.on('data', (d: Buffer) => { proxyLogText += d.toString(); });
  await waitForOutput(proxyProcess, /Registered with proxy namespace/, 20_000, 'proxy namespace registration');

  // Fake controller: capture acp:start (with the mcpEndpoint payload)
  const ctrlKeyRes = await gqlRequest(
    `mutation CreateControllerKey($input: CreateKeyInput!) { createControllerKey(input: $input) { rawKey } }`,
    { input: { name: `mcppt-ctrl-${Date.now()}`, type: 'local' } },
    token,
  );
  const ctrlKey = (await ctrlKeyRes.json()).data.createControllerKey.rawKey as string;
  const controllerSocket = SocketIOClient(CONTROLLER_API_URL, { transports: ['websocket'], reconnection: false, forceNew: true });
  const registered = await new Promise<{ controllerId: string }>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('controller register timeout')), 10_000);
    controllerSocket.once('registered', (d: { controllerId: string }) => { clearTimeout(timer); resolvePromise(d); });
    controllerSocket.emit('register', { key: ctrlKey, hostname: 'mcppt-host', version: '2.0.0' });
  });
  const controllerId = registered.controllerId;

  const wsRes = await gqlRequest(
    `mutation CreateWorkspace($input: CreateWorkspaceInput!) { createWorkspace(input: $input) { id } }`,
    { input: { controllerId, path: `/tmp/mcppt-${Date.now()}` } },
    token,
  );
  const workspaceId = (await wsRes.json()).data.createWorkspace.id as string;

  const dirRes = await gqlRequest(`query { mcpServers { id name } }`, {}, token);
  const servers = (await dirRes.json()).data.mcpServers as Array<{ id: string; name: string }>;
  const server = servers.find((s) => s.name === MCP_SERVER_NAME);
  expect(server, `registered MCP server ${MCP_SERVER_NAME} should be listed`).toBeTruthy();

  const acpStartPromise = new Promise<Record<string, any>>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('acp:start timeout')), 15_000);
    controllerSocket.once('acp:start', (d: Record<string, any>) => { clearTimeout(timer); resolvePromise(d); });
  });
  const createRes = await gqlRequest(
    `mutation CreateSession($input: CreateSessionInput!) { createSession(input: $input) { session { id status } } }`,
    { input: { controllerId, acpServerType: 'opencode', workspaceId, mcpServerIds: [server!.id] } },
    token,
  );
  const created = await createRes.json();
  const sessionId = created.data.createSession.session.id as string;
  const acpStart = await acpStartPromise;

  // Answer acp:start with success so the session stays alive and the endpoint
  // is not revoked by the creating-timeout cleanup.
  controllerSocket.emit('acp:start:result', {
    requestId: acpStart.requestId,
    sessionId,
    success: true,
    externalSessionId: `ext_${Date.now()}`,
  });

  const mcpEndpoint = acpStart.mcpEndpoint as ChainContext['mcpEndpoint'];
  expect(mcpEndpoint, 'acp:start should carry mcpEndpoint').toBeTruthy();

  return {
    token,
    userId,
    controllerId,
    controllerSocket,
    proxyProcess,
    proxyLog: () => proxyLogText,
    binDir,
    sessionId,
    mcpEndpoint,
    serverName: mcpEndpoint.serverNames[0],
  };
}

function teardownChain(ctx: ChainContext): void {
  ctx.controllerSocket.disconnect();
  ctx.proxyProcess.kill('SIGTERM');
  rmSync(ctx.binDir, { recursive: true, force: true });
}

// Drive an MCP request through the relay protocol exactly as the real
// agent-controller does: emit `mcp:request` on the controller WebSocket and
// resolve the matching `mcp:response` (controller-api validates the session
// belongs to this controller, publishes Redis, agent-api relays and publishes
// back, controller-api emits `mcp:response`).
async function postMcp(ctx: ChainContext, body: Record<string, unknown>): Promise<{ status: number; latencyMs: number; json: any }> {
  const requestId = `mcpreq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const t0 = Date.now();
  const res = await new Promise<{ status: number; body: any }>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`mcp:response timeout for ${requestId}`)), 15_000);
    const onResponse = (payload: { requestId: string; status: number; body: any }) => {
      if (payload.requestId !== requestId) return;
      clearTimeout(timer);
      ctx.controllerSocket.off('mcp:response', onResponse);
      resolvePromise({ status: payload.status, body: payload.body });
    };
    ctx.controllerSocket.on('mcp:response', onResponse);
    ctx.controllerSocket.emit('mcp:request', {
      requestId,
      sessionId: ctx.sessionId,
      serverName: ctx.serverName,
      token: ctx.mcpEndpoint.token,
      body,
    });
  });
  let json: any = null;
  try { json = res.body; } catch { /* 202 has no body */ }
  return { status: res.status, latencyMs: Date.now() - t0, json };
}

describe('ACP MCP passthrough (real services)', () => {
  let ctx: ChainContext;

  beforeAll(async () => {
    ctx = await setupChain();
  }, 60_000);

  afterAll(() => {
    if (ctx) teardownChain(ctx);
  });

  it('should hand the agent a contract-conformant MCP endpoint', () => {
    // contracts/agent-session-websocket.md: mcpEndpoint = { token, serverNames }
    // (public /mcp url removed; relayed via controller loopback → WebSocket)
    expect(ctx.mcpEndpoint.token).toBeTruthy();
    expect(ctx.mcpEndpoint.serverNames).toEqual([MCP_SERVER_NAME]);
    expect(ctx.mcpEndpoint.url).toBeUndefined();
  });

  it('should complete an MCP initialize handshake through the gateway chain', async () => {
    const res = await postMcp(ctx, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    });
    expect(res.status).toBe(200);
    expect(res.latencyMs).toBeLessThan(10_000);
    expect(res.json.result?.serverInfo?.name).toBe('mock-mcp-probe');
  }, 30_000);

  it('should answer JSON-RPC notifications with 202 immediately (not the 30s forward timeout)', async () => {
    const res = await postMcp(ctx, { jsonrpc: '2.0', method: 'notifications/initialized' });
    // Regression: notifications were forwarded as request/response and stalled
    // for 30s (FORWARD_TIMEOUT), which silently broke agent MCP onboarding.
    expect(res.status).toBe(202);
    expect(res.latencyMs).toBeLessThan(10_000);
  }, 30_000);

  it('should list the mock MCP tools through the gateway chain', async () => {
    const res = await postMcp(ctx, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(res.status).toBe(200);
    const toolNames = (res.json.result?.tools ?? []).map((t: { name: string }) => t.name);
    expect(toolNames).toContain(TOOL_NAME);
  }, 30_000);

  it('should invoke the mock MCP tool through the relay chain and return the marker', async () => {
    // The public per-server url no longer exists; the mock tool only echoes the
    // address it was given, so pass a relay-flavoured placeholder.
    const address = `mock://relay/${encodeURIComponent(ctx.serverName)}`;
    const res = await postMcp(ctx, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: TOOL_NAME, arguments: { address } },
    });
    expect(res.status).toBe(200);
    const text = res.json.result?.content?.[0]?.text ?? '';
    expect(text).toContain(MARKER);
    expect(text).toContain(`address=${address}`);
  }, 30_000);
});

// ── real opencode agent: MCP servers handed via ACP session/new must be
// registered into the agent, and the agent must be able to call their tools ──

interface AcpClient {
  send: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<any>;
  toolCalls: string[];
  agentText: () => string;
  close: () => void;
}

// Drive a real `opencode acp` process over ndjson JSON-RPC, exactly like the
// agent-controller bridge does (same mcpServers assembly, auto-allowing
// permission prompts so MCP tool calls can execute).
function spawnOpencodeAcp(cwd: string): AcpClient {
  const proc = spawn('opencode', ['acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stderr.on('data', (d: Buffer) => console.log(`[opencode stderr] ${d.toString().trim().slice(0, 300)}`));

  let buf = '';
  const pending = new Map<number, (msg: any) => void>();
  let nextId = 1;
  const toolCalls: string[] = [];
  let text = '';

  proc.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && msg.method === 'session/request_permission') {
        const opt = msg.params?.options?.[0];
        proc.stdin.write(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { outcome: { outcome: 'selected', optionId: opt?.optionId } },
        }) + '\n');
        continue;
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
        continue;
      }
      if (msg.method === 'session/update') {
        const u = msg.params?.update;
        if (u?.sessionUpdate === 'tool_call' || u?.sessionUpdate === 'tool_call_update') {
          toolCalls.push(u.title ?? u.kind ?? u.status ?? 'tool_call');
        }
        if (u?.sessionUpdate === 'agent_message_chunk') text += u.content?.text ?? '';
      }
    }
  });

  return {
    toolCalls,
    agentText: () => text,
    send(method, params, timeoutMs = 120_000) {
      const id = nextId++;
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((resolvePromise, reject) => {
        pending.set(id, resolvePromise);
        setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout waiting ${method}`)); }, timeoutMs);
      });
    },
    close() { proc.kill('SIGTERM'); },
  };
}

interface LoopbackRelay {
  url: string;
  port: number;
  close: () => Promise<void>;
}

// Spin up a real loopback HTTP endpoint mimicking the agent-controller's
// local-server.ts + relay.ts: POST /mcp/{sessionId}/{serverName} is converted
// into a `mcp:request` emit, and the matching `mcp:response` is written back to
// the HTTP response. This is what the real bridge hands the agent.
function createLoopbackRelay(ctx: ChainContext): Promise<LoopbackRelay> {
  const server: Server = http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const match = /^\/mcp\/([^/]+)\/([^/]+)\/?$/.exec(req.url ?? '');
    if (!match) { res.writeHead(404); res.end(); return; }
    const sessionId = decodeURIComponent(match[1]);
    const serverName = decodeURIComponent(match[2]);

    let bodyStr = '';
    req.on('data', (chunk) => { bodyStr += chunk; });
    req.on('end', () => {
      let body: unknown;
      try { body = JSON.parse(bodyStr || '{}'); } catch { res.writeHead(400); res.end(); return; }
      const requestId = `mcpreq_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const timer = setTimeout(() => { res.writeHead(504); res.end(); }, 60_000);
      const onResponse = (payload: { requestId: string; status: number; body: any }) => {
        if (payload.requestId !== requestId) return;
        clearTimeout(timer);
        ctx.controllerSocket.off('mcp:response', onResponse);
        res.writeHead(payload.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload.body));
      };
      ctx.controllerSocket.on('mcp:response', onResponse);
      ctx.controllerSocket.emit('mcp:request', {
        requestId,
        sessionId,
        serverName,
        token: ctx.mcpEndpoint.token,
        body,
      });
    });
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.off('error', reject);
      resolvePromise({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe('opencode agent MCP passthrough (real agent)', () => {
  const hasOpencode = commandExists('opencode');
  let ctx: ChainContext;
  let relay: LoopbackRelay;
  let acp: AcpClient;
  let acpCwd = '';

  beforeAll(async () => {
    if (!hasOpencode) return;
    ctx = await setupChain();
    relay = await createLoopbackRelay(ctx);
    acpCwd = mkdtempSync(join(tmpdir(), 'acp-mcppt-'));
    acp = spawnOpencodeAcp(acpCwd);
  }, 90_000);

  afterAll(() => {
    acp?.close();
    relay?.close();
    if (ctx) teardownChain(ctx);
    if (acpCwd) rmSync(acpCwd, { recursive: true, force: true });
  });

  it('should register the MCP server into opencode and let the agent call its tool', async () => {
    if (!hasOpencode) {
      console.log('SKIP: opencode binary not found');
      return;
    }

    await acp.send('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });

    // identical to agent-controller bridge.ts toMcpEndpointServers(): the agent
    // is handed the loopback relay URL for each server, which relays via WS.
    const session = await acp.send('session/new', {
      cwd: acpCwd,
      mcpServers: ctx.mcpEndpoint.serverNames.map((name) => ({
        type: 'http',
        name,
        url: `${relay.url}/mcp/${ctx.sessionId}/${encodeURIComponent(name)}`,
        headers: [{ name: 'Authorization', value: `Bearer ${ctx.mcpEndpoint.token}` }],
      })),
    });
    const acpSessionId = session.result?.sessionId;
    expect(acpSessionId).toBeTruthy();

    const prompt = await acp.send('session/prompt', {
      sessionId: acpSessionId,
      prompt: [{
        type: 'text',
        text:
          `You may have an MCP tool named "${TOOL_NAME}". ` +
          `If you have it, call it exactly once with arguments {"address": "mcp-passthrough-probe"} and after the call reply with exactly TOOL_OK. ` +
          `If you do NOT have a tool named "${TOOL_NAME}", reply with exactly TOOL_MISSING and nothing else.`,
      }],
    }, 180_000);
    expect(prompt.error).toBeUndefined();

    const text = acp.agentText();
    console.log('agent tool calls:', JSON.stringify(acp.toolCalls));
    console.log('agent text:', text.slice(0, 500));
    console.log('mcp-proxy log:\n' + ctx.proxyLog());

    // The deterministic string makes failures diagnosable: TOOL_MISSING means
    // the MCP server never made it into the agent.
    expect(text).not.toContain('TOOL_MISSING');
    expect(text).toContain('TOOL_OK');
    expect(acp.toolCalls.length).toBeGreaterThan(0);
  }, 240_000);
});
