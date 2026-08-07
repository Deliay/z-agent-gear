import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir, tmpdir } from 'os';

const AGENT_API_URL = (process.env.API_URL || 'http://localhost:36447') + '/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:40821';
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
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(AGENT_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
}

const SIGNUP = `mutation Signup($username: String!, $password: String!) { signup(username: $username, password: $password) { token user { id username } } }`;
const CREATE_KEY = `mutation CreateControllerKey($input: CreateKeyInput!) { createControllerKey(input: $input) { rawKey } }`;
const CREATE_WORKSPACE = `mutation CreateWorkspace($input: CreateWorkspaceInput!) { createWorkspace(input: $input) { id controllerId path } }`;
const LIST_HISTORY = `query ListHistorySessions($controllerId: ID!, $workspaceId: ID!) { listHistorySessions(controllerId: $controllerId, workspaceId: $workspaceId) { sessionId title cwd updatedAt } }`;
const IMPORT_HISTORY = `mutation ImportHistorySessions($controllerId: ID!, $workspaceId: ID!, $sessionIds: [String!]!) { importHistorySessions(controllerId: $controllerId, workspaceId: $workspaceId, sessionIds: $sessionIds) { sessionId acpSessionId title success error messageCount } }`;
const CONTROLLER_QUERY = `query Controller($id: ID!) { controller(id: $id) { id status hostname } }`;

function writeControllerConfig(key: string, endpoint: string): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, `[key]\nvalue = "${key}"\n[server]\nendpoint = "${endpoint}"\n`, 'utf-8');
}

function backupConfig(): string | null {
  if (existsSync(CONFIG_FILE)) return readFileSync(CONFIG_FILE, 'utf-8');
  return null;
}

function restoreConfig(backup: string | null): void {
  if (backup !== null) writeFileSync(CONFIG_FILE, backup, 'utf-8');
  else if (existsSync(CONFIG_FILE)) unlinkSync(CONFIG_FILE);
}

function cleanupPidFile(): void {
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
}

function spawnController(): { process: ChildProcess; waitForRegistered: Promise<string> } {
  const proc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: CONTROLLER_PKG,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: spawnEnv(),
  });

  proc.stdout?.on('data', (data: Buffer) => { console.log(`[ctrl-out] ${data.toString().trim()}`); });
  proc.stderr?.on('data', (data: Buffer) => { console.log(`[ctrl-err] ${data.toString().trim()}`); });

  const waitForRegistered = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Controller registration timeout')), 30_000);
    let output = '';
    const onData = (data: Buffer) => {
      const chunk = data.toString();
      output += chunk;
      const match = output.match(/Controller registered: (\w+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    };
    proc.stdout?.on('data', onData);
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`Controller process exited with code ${code}. Output: ${output}`));
      }
    });
  });

  return { process: proc, waitForRegistered };
}

async function waitForControllerOnline(controllerId: string, token: string, timeoutMs = 20_000): Promise<void> {
  for (let i = 0; i < timeoutMs / 500; i++) {
    const res = await gqlRequest(CONTROLLER_QUERY, { id: controllerId }, token);
    const body = await res.json();
    const ctrl = body.data?.controller;
    if (ctrl?.status === 'online') return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Controller did not come online');
}

let authToken = '';
let rawKey = '';
let controllerId = '';
let controllerProcess: ChildProcess | null = null;
let configBackup: string | null = null;

describe('ACP Real Session Import with minefield-online', () => {
  beforeAll(async () => {
    cleanupPidFile();
    configBackup = backupConfig();

    const uid = `rimp_${Date.now().toString(36)}`;
    const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const body = await res.json();
    authToken = body.data.signup.token;
    expect(authToken).toBeTruthy();

    const keyRes = await gqlRequest(CREATE_KEY, { input: { name: `rimp-${Date.now()}`, type: 'local' } }, authToken);
    const keyBody = await keyRes.json();
    rawKey = keyBody.data.createControllerKey.rawKey;
    expect(rawKey).toBeTruthy();
    console.log(`Created key: ${rawKey.substring(0, 24)}...`);

    writeControllerConfig(rawKey, CONTROLLER_API_URL);

    const { process: proc, waitForRegistered } = spawnController();
    controllerProcess = proc;
    controllerId = await waitForRegistered;
    console.log(`Controller registered: ${controllerId}`);
    await waitForControllerOnline(controllerId, authToken);
    console.log(`Controller is online`);
  }, 45_000);

  afterAll(async () => {
    if (controllerProcess) {
      controllerProcess.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1000));
    }
    cleanupPidFile();
    restoreConfig(configBackup);
  });

  it('should list and import session from minefield-online', async () => {
    const MINE_PATH = '/home/ash/Repositories/minefield-online';
    const SESSION_ID = 'ses_24fb5c5c0ffedD6akXHgfyyANS';

    // Create workspace pointing to minefield-online
    console.log(`Creating workspace: ${MINE_PATH}`);
    const wsRes = await gqlRequest(
      CREATE_WORKSPACE,
      { input: { controllerId, path: MINE_PATH } },
      authToken,
    );
    const wsBody = await wsRes.json();
    const wsId = wsBody.data.createWorkspace.id;
    expect(wsId).toBeTruthy();
    console.log(`Workspace created: ${wsId}`);

    // List history sessions
    console.log('Listing history sessions...');
    const listStart = Date.now();
    const listRes = await gqlRequest(LIST_HISTORY, { controllerId, workspaceId: wsId }, authToken);
    const listBody = await listRes.json();
    const listDuration = Date.now() - listStart;
    console.log(`List duration: ${listDuration}ms`);
    if (listBody.errors) {
      console.error('List errors:', JSON.stringify(listBody.errors));
    }
    expect(listBody.errors).toBeUndefined();
    const sessions = listBody.data.listHistorySessions;
    console.log(`Found ${sessions.length} sessions:`, JSON.stringify(sessions));

    // Import the specific session
    console.log(`Importing session: ${SESSION_ID}`);
    const importStart = Date.now();
    const impRes = await gqlRequest(
      IMPORT_HISTORY,
      { controllerId, workspaceId: wsId, sessionIds: [SESSION_ID] },
      authToken,
    );
    const importDuration = Date.now() - importStart;
    const impBody = await impRes.json();
    console.log(`Import duration: ${importDuration}ms`);
    console.log(`Import response:`, JSON.stringify(impBody, null, 2));

    if (impBody.errors) {
      console.error('GraphQL errors:', JSON.stringify(impBody.errors));
    }

    const result = impBody.data?.importHistorySessions?.[0];
    expect(result).toBeDefined();
    console.log(`Result: success=${result?.success}, messageCount=${result?.messageCount}, error=${result?.error}`);

    expect(result.success).toBe(true);
    expect(result.messageCount).toBeGreaterThan(0);
  }, 180_000);
});
