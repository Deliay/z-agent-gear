import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir, tmpdir } from 'os';
import { createFrontUser } from '../support/front-users.js';

const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';

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

function spawnController(): { process: ChildProcess; waitForRegistered: Promise<string> } {
  const proc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: CONTROLLER_PKG,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: spawnEnv(),
  });

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
      if (body.data?.controller?.status === 'online') return;
    } catch {
      // retry
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

// Real-agent smoke test: spawns the real agent-controller process, which spawns
// a real `opencode acp` agent. The bridge now advertises
// clientCapabilities.elicitation { form, url } during initialize — this test
// proves the real opencode ACP server accepts the handshake and reaches a
// running session with the elicitation capability declared.
describe('ACP Real Agent Elicitation Handshake (opencode)', () => {
  let controllerProcess: ChildProcess | null = null;
  let controllerId = '';
  let authToken = '';
  let configBackup: string | null = null;

  beforeAll(async () => {
    cleanupPidFile();
    configBackup = backupConfig();

    const frontUser = await createFrontUser();
    authToken = frontUser.token;
    expect(authToken).toBeTruthy();

    const keyRes = await gqlRequest(
      CREATE_KEY,
      { input: { name: `real-elic-${Date.now()}`, type: 'local' } },
      authToken,
    );
    const keyBody = await keyRes.json();
    const rawKey = keyBody.data.createControllerKey.rawKey;
    expect(rawKey).toBeTruthy();

    writeControllerConfig(rawKey, CONTROLLER_API_URL);

    const { process: proc, waitForRegistered } = spawnController();
    controllerProcess = proc;

    controllerId = await waitForRegistered;
    expect(controllerId).toBeTruthy();

    await waitForControllerOnline(controllerId, authToken);
  }, 30_000);

  afterAll(async () => {
    if (controllerProcess) {
      controllerProcess.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
    }
    cleanupPidFile();
    restoreConfig(configBackup);
  });

  it('should complete initialize (with elicitation capabilities) and session/new against real opencode', async () => {
    const wsRes = await gqlRequest(
      CREATE_WORKSPACE,
      { input: { controllerId, path: `/tmp/acp-real-elic-${Date.now()}` } },
      authToken,
    );
    const wsBody = await wsRes.json();
    const workspaceId = wsBody.data.createWorkspace.id;

    const sessionRes = await gqlRequest(
      CREATE_SESSION,
      { input: { controllerId, acpServerType: 'opencode', workspaceId } },
      authToken,
    );
    const sessionBody = await sessionRes.json();
    const sessionId = sessionBody.data.createSession.session.id;
    expect(sessionId).toBeTruthy();

    // Reaching 'idling' proves: initialize handshake with
    // clientCapabilities.elicitation { form, url } succeeded and session/new
    // completed against the real opencode ACP server.
    const status = await waitForSessionStatus(sessionId, 'idling', authToken, 45_000);
    expect(status).toBe('idling');
  }, 60_000);
});
