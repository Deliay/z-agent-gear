import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir, tmpdir } from 'os';

/**
 * 真实 OpenCode 能力快照回归（test:real 套件）。
 * 链路：createSession → 真实 agent-controller → real `opencode acp` initialize
 * → capabilities 归一化 → acp:start:result → controller-api 落库 → GraphQL 读取。
 */

const AGENT_API_URL = process.env.API_URL || 'http://localhost:4000/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

const CONTROLLER_PKG = resolve(__dirname, '../../../../packages/agent-controller');
const CONFIG_DIR = join(homedir(), '.zag');
const CONFIG_FILE = join(CONFIG_DIR, 'config.toml');
const PID_FILE = join(tmpdir(), 'agent-controller.pid');

function spawnEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env = { ...process.env, NODE_OPTIONS: '--import tsx', ...extra };
  delete env.ZAG_CONTROLLER_KEY;
  delete env.ZAG_SERVER_ENDPOINT;
  return env;
}

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(AGENT_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
}

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) { token user { id username } }
  }
`;

const CREATE_KEY = `
  mutation CreateControllerKey($input: CreateKeyInput!) {
    createControllerKey(input: $input) { rawKey key { id } }
  }
`;

const CREATE_WORKSPACE = `
  mutation CreateWorkspace($input: CreateWorkspaceInput!) {
    createWorkspace(input: $input) { id controllerId path }
  }
`;

const CREATE_SESSION = `
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) { session { id status } }
  }
`;

const SESSION_QUERY = `
  query Session($id: ID!) {
    session(id: $id) {
      id status
      agentCapabilities {
        protocolVersion
        agentInfo { name version }
        raw
        features { id status detail }
      }
      features { id status detail }
    }
  }
`;

const CONTROLLER_QUERY = `
  query Controller($id: ID!) { controller(id: $id) { id status hostname } }
`;

function writeControllerConfig(key: string, endpoint: string): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, `[key]\nvalue = "${key}"\n[server]\nendpoint = "${endpoint}"\n`, 'utf-8');
}

function backupConfig(): string | null {
  return existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf-8') : null;
}

function restoreConfig(backup: string | null): void {
  if (backup !== null) {
    writeFileSync(CONFIG_FILE, backup, 'utf-8');
  } else if (existsSync(CONFIG_FILE)) {
    unlinkSync(CONFIG_FILE);
  }
}

function spawnController(): { process: ChildProcess; waitForRegistered: Promise<string> } {
  const proc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: CONTROLLER_PKG,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: spawnEnv(),
  });

  proc.stderr?.on('data', (data: Buffer) => {
    console.log(`[controller stderr] ${data.toString().trim()}`);
  });

  const waitForRegistered = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Controller registration timeout')), 15_000);
    let output = '';
    proc.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
      const match = output.match(/Controller registered: (\w+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`Controller process exited with code ${code}. Output: ${output}`));
      }
    });
  });

  return { process: proc, waitForRegistered };
}

async function waitForControllerOnline(controllerId: string, token: string, timeoutMs = 15_000): Promise<void> {
  for (let i = 0; i < timeoutMs / 500; i++) {
    const res = await gqlRequest(CONTROLLER_QUERY, { id: controllerId }, token);
    const body = await res.json();
    if (body.data?.controller?.status === 'online') return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Controller did not come online');
}

async function waitForSession(sessionId: string, token: string, timeoutMs = 60_000): Promise<any> {
  for (let i = 0; i < timeoutMs / 500; i++) {
    const res = await gqlRequest(SESSION_QUERY, { id: sessionId }, token);
    const body = await res.json();
    const session = body.data?.session;
    if (session?.status === 'idling') return session;
    if (session?.status === 'ended') throw new Error(`Session ended before idling: ${JSON.stringify(body)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Session did not become idling within ${timeoutMs}ms`);
}

describe('ACP Real OpenCode Capability Snapshot', () => {
  let controllerProcess: ChildProcess | null = null;
  let controllerId = '';
  let authToken = '';
  let configBackup: string | null = null;

  beforeAll(async () => {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    configBackup = backupConfig();

    const uid = `acp_cap_${Date.now().toString(36)}`;
    const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const body = await res.json();
    authToken = body.data?.signup?.token;
    expect(authToken).toBeTruthy();

    const keyRes = await gqlRequest(
      CREATE_KEY,
      { input: { name: `real-cap-${Date.now()}`, type: 'local' } },
      authToken,
    );
    const keyBody = await keyRes.json();
    const rawKey = keyBody.data.createControllerKey.rawKey;
    expect(rawKey).toBeTruthy();

    writeControllerConfig(rawKey, CONTROLLER_API_URL);
    const { process: proc, waitForRegistered } = spawnController();
    controllerProcess = proc;
    controllerId = await waitForRegistered;
    await waitForControllerOnline(controllerId, authToken);
  }, 45_000);

  afterAll(async () => {
    if (controllerProcess) {
      controllerProcess.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
    }
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    restoreConfig(configBackup);
  });

  it('T-ARC1: 真实 OpenCode 会话落库 agentCapabilities.raw 与 features', async () => {
    const wsRes = await gqlRequest(
      CREATE_WORKSPACE,
      { input: { controllerId, path: `/tmp/acp-cap-real-${Date.now()}` } },
      authToken,
    );
    const wsBody = await wsRes.json();
    const workspaceId = wsBody.data.createWorkspace.id;

    const res = await gqlRequest(
      CREATE_SESSION,
      { input: { controllerId, acpServerType: 'opencode', workspaceId } },
      authToken,
    );
    const body = await res.json();
    const sessionId = body.data?.createSession?.session?.id;
    expect(sessionId).toBeTruthy();

    const session = await waitForSession(sessionId, authToken);
    expect(session.agentCapabilities).not.toBeNull();
    expect(session.agentCapabilities.raw.agentCapabilities.sessionCapabilities).toBeDefined();
    expect(session.features.length).toBeGreaterThanOrEqual(20);

    const byId = new Map<string, any>(session.features.map((f: any) => [f.id, f]));
    expect(byId.get('session.load')?.status).toBe('supported');
    expect(byId.get('prompt.audio')?.status).toBe('unsupported');
    expect(byId.get('elicitation.form')?.status).toBe('supported');
  }, 90_000);

  it('T-ARC2: partial 项与调研附录判断一致', async () => {
    const sessionsRes = await gqlRequest(
      `query { sessions { id agentCapabilities { features { id status } } features { id status } } }`,
      undefined,
      authToken,
    );
    const sessionsBody = await sessionsRes.json();
    const session = (sessionsBody.data?.sessions ?? []).find(
      (s: any) => Array.isArray(s.features) && s.features.length > 0,
    );
    expect(session).toBeDefined();
    const byId = new Map<string, any>(session.features.map((f: any) => [f.id, f]));
    // OpenCode 声明 fork/additionalDirectories/image 能力，但平台暂无入口 → partial
    for (const id of ['session.fork', 'session.additionalDirectories', 'prompt.image']) {
      if (byId.has(id)) expect(byId.get(id).status).toBe('partial');
    }
  }, 30_000);
});
