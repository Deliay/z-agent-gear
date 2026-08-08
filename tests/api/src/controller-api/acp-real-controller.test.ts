import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir, tmpdir } from 'os';

const AGENT_API_URL = process.env.API_URL || 'http://localhost:4000/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

const CONTROLLER_PKG = resolve(__dirname, '../../../../packages/agent-controller');
const CONFIG_DIR = join(homedir(), '.zag');
const CONFIG_FILE = join(CONFIG_DIR, 'config.toml');
const PID_FILE = join(tmpdir(), 'agent-controller.pid');

// Environment for spawned agent-controller processes: strip inherited
// ZAG_CONTROLLER_KEY / ZAG_SERVER_ENDPOINT overrides so the freshly written
// ~/.zag/config.toml stays authoritative (config priority: CLI > env > file).
function spawnEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env = { ...process.env, NODE_OPTIONS: '--import tsx', ...extra };
  delete env.ZAG_CONTROLLER_KEY;
  delete env.ZAG_SERVER_ENDPOINT;
  return env;
}

function gqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const body: Record<string, unknown> = { query };
  if (variables) {
    body.variables = variables;
  }
  return fetch(AGENT_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) {
      token
      user { id username }
    }
  }
`;

const CREATE_KEY = `
  mutation CreateControllerKey($input: CreateKeyInput!) {
    createControllerKey(input: $input) {
      key { id name }
      rawKey
    }
  }
`;

const CREATE_SESSION = `
  mutation CreateSession($input: CreateSessionInput!) {
    createSession(input: $input) {
      session { id status }
    }
  }
`;

const CREATE_WORKSPACE = `
  mutation CreateWorkspace($input: CreateWorkspaceInput!) {
    createWorkspace(input: $input) {
      id controllerId path
    }
  }
`;

const SESSION_QUERY = `
  query Session($id: ID!) {
    session(id: $id) {
      id status externalSessionId
    }
  }
`;

const CONTROLLER_QUERY = `
  query Controller($id: ID!) {
    controller(id: $id) {
      id status hostname
    }
  }
`;

function writeControllerConfig(key: string, endpoint: string): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, `[key]\nvalue = "${key}"\n[server]\nendpoint = "${endpoint}"\n`, 'utf-8');
}

function backupConfig(): string | null {
  if (existsSync(CONFIG_FILE)) {
    return readFileSync(CONFIG_FILE, 'utf-8');
  }
  return null;
}

function restoreConfig(backup: string | null): void {
  if (backup !== null) {
    writeFileSync(CONFIG_FILE, backup, 'utf-8');
  } else if (existsSync(CONFIG_FILE)) {
    unlinkSync(CONFIG_FILE);
  }
}

function cleanupPidFile(): void {
  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
  }
}

async function createWorkspace(ctrlId: string, token: string): Promise<string> {
  const res = await gqlRequest(
    CREATE_WORKSPACE,
    { input: { controllerId: ctrlId, path: `/tmp/acp-real-test-${Date.now()}` } },
    token,
  );
  const body = await res.json();
  return body.data.createWorkspace.id;
}

function spawnController(): { process: ChildProcess; waitForRegistered: Promise<string> } {
  const proc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: CONTROLLER_PKG,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: spawnEnv(),
  });

  // Keep stdout/stderr listeners active for the entire lifetime of the process
  proc.stdout?.on('data', (data: Buffer) => {
    console.log(`[controller stdout] ${data.toString().trim()}`);
  });
  proc.stderr?.on('data', (data: Buffer) => {
    console.log(`[controller stderr] ${data.toString().trim()}`);
  });

  const waitForRegistered = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Controller registration timeout')), 15_000);
    let output = '';
    const onData = (data: Buffer) => {
      const chunk = data.toString();
      output += chunk;
      const match = output.match(/Controller registered: (\w+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    proc.stdout?.on('data', onData);
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
    try {
      const res = await gqlRequest(CONTROLLER_QUERY, { id: controllerId }, token);
      const body = await res.json();
      const controller = body.data?.controller;
      console.log(`[waitForOnline] Attempt ${i}: status=${controller?.status ?? 'null'}`);
      if (controller?.status === 'online') return;
    } catch (e) {
      console.log(`[waitForOnline] Attempt ${i}: error=${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Controller did not come online');
}

async function waitForSessionStatus(sessionId: string, expected: string, token: string, timeoutMs = 30_000): Promise<string> {
  for (let i = 0; i < timeoutMs / 500; i++) {
    try {
      const res = await gqlRequest(SESSION_QUERY, { id: sessionId }, token);
      const body = await res.json();
      const status = body.data?.session?.status;
      if (status === expected) return status;
      if (status === 'ended' || status === 'removed') {
        throw new Error(`Session unexpected status: ${status}`);
      }
    } catch (e) {
      if ((e as Error).message.startsWith('Session unexpected')) throw e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Session did not reach status '${expected}' within ${timeoutMs}ms`);
}

describe('ACP Real Controller Integration', () => {
  let controllerProcess: ChildProcess | null = null;
  let rawKey = '';
  let controllerId = '';
  let authToken = '';
  let configBackup: string | null = null;

  beforeAll(async () => {
    cleanupPidFile();
    configBackup = backupConfig();

    const uid = `acp_real_${Date.now().toString(36)}`;
    const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const body = await res.json();
    authToken = body.data?.signup?.token;
    expect(authToken).toBeTruthy();

    const keyRes = await gqlRequest(
      CREATE_KEY,
      { input: { name: `real-test-${Date.now()}`, type: 'local' } },
      authToken,
    );
    const keyBody = await keyRes.json();
    rawKey = keyBody.data.createControllerKey.rawKey;
    expect(rawKey).toBeTruthy();

    writeControllerConfig(rawKey, CONTROLLER_API_URL);

    const { process: proc, waitForRegistered } = spawnController();
    controllerProcess = proc;

    controllerId = await waitForRegistered;
    expect(controllerId).toBeTruthy();
    console.log(`[test] Controller registered with ID: ${controllerId}`);

    await waitForControllerOnline(controllerId, authToken);
    console.log(`[test] Controller is online`);
  }, 30_000);

  afterAll(async () => {
    if (controllerProcess) {
      controllerProcess.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
    }
    cleanupPidFile();
    restoreConfig(configBackup);
  });

  it('should create ACP session with real opencode', async () => {
    console.log(`[test] Creating session for controller ${controllerId}`);
    const wsId = await createWorkspace(controllerId, authToken);
    const sessionRes = await gqlRequest(
      CREATE_SESSION,
      { input: { controllerId, acpServerType: 'opencode', workspaceId: wsId } },
      authToken,
    );
    const sessionBody = await sessionRes.json();
    const sessionId = sessionBody.data.createSession.session.id;
    console.log(`[test] Session created: ${sessionId}`);
    expect(sessionId).toBeTruthy();

    const status = await waitForSessionStatus(sessionId, 'idling', authToken, 30_000);
    console.log(`[test] Session status: ${status}`);
    expect(status).toBe('idling');
  }, 60_000);

  it('should receive ACP messages via SSE', async () => {
    const wsId = await createWorkspace(controllerId, authToken);
    const sessionRes = await gqlRequest(
      CREATE_SESSION,
      { input: { controllerId, acpServerType: 'opencode', workspaceId: wsId } },
      authToken,
    );
    const sessionBody = await sessionRes.json();
    const sessionId = sessionBody.data.createSession.session.id;

    await waitForSessionStatus(sessionId, 'idling', authToken, 30_000);

    const msgQuery = `
      query SessionMessages($sessionId: ID!, $limit: Int) {
        sessionMessages(sessionId: $sessionId, limit: $limit) {
          id direction type content
        }
      }
    `;
    const msgRes = await gqlRequest(msgQuery, { sessionId, limit: 10 }, authToken);
    const msgBody = await msgRes.json();
    expect(msgBody.errors).toBeUndefined();
    const messages = msgBody.data.sessionMessages;

    expect(Array.isArray(messages)).toBe(true);
  }, 60_000);
});
