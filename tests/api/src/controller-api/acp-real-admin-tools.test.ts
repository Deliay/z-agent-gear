import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, unlinkSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir, tmpdir } from 'os';

// Real end-to-end investigation for the downstream rejection:
//   普通会话勾选「agent-workflow-admin-tools」后，agent 实际会话中没有该工具集的工具。
// Chain under test (all REAL, no fake controller / no relay mimic):
//   createSession(mcpServerIds=[admin-tools]) → acp:start → real agent-controller
//   bridge → session/new(loopback URL) → real opencode → POST 127.0.0.1 loopback
//   → local-server.ts → relay.ts → WS mcp:request → controller-api mcp-relay
//   → Redis → agent-api mcp-relay-consumer → dispatch → handleAdminPlatformMcpRequest
// Diagnostics: agent-controller local-server/relay log every request + status;
// server side logs are read via `aspire logs agent-api` / `aspire logs controller-api`.

const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:35273';

const CONTROLLER_PKG = resolve(__dirname, '../../../../packages/agent-controller');
const CONFIG_DIR = join(homedir(), '.zag');
const CONFIG_FILE = join(CONFIG_DIR, 'config.toml');
const PID_FILE = join(tmpdir(), 'agent-controller.pid');

const ADMIN_SERVER_NAME = 'agent-workflow-admin-tools';

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
  return fetch(AGENT_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
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

// mcpServers 查询会在读路径幂等 ensure admin 平台服务（mcp-server.ts resolver）
const MCP_SERVERS_QUERY = `
  query McpServers {
    mcpServers {
      id name transport source enabled
    }
  }
`;

const SEND_SESSION_MESSAGE = `
  mutation SendSessionMessage($sessionId: ID!, $content: String!) {
    sendSessionMessage(sessionId: $sessionId, content: $content) {
      id direction
    }
  }
`;

const SESSION_MESSAGES_QUERY = `
  query SessionMessages($sessionId: ID!, $limit: Int) {
    sessionMessages(sessionId: $sessionId, limit: $limit) {
      id direction type content
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
  return existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf-8') : null;
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

/** 捕获真实 agent-controller 全部输出，供断言传链路与事后排查 */
const controllerLogLines: string[] = [];

function spawnController(): { process: ChildProcess; waitForRegistered: Promise<string> } {
  const proc = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: CONTROLLER_PKG,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: spawnEnv(),
  });

  const onChunk = (tag: string) => (data: Buffer) => {
    const text = data.toString().trim();
    for (const line of text.split('\n')) {
      controllerLogLines.push(line);
      console.log(`[controller ${tag}] ${line}`);
    }
  };
  proc.stdout?.on('data', onChunk('stdout'));
  proc.stderr?.on('data', onChunk('stderr'));

  const waitForRegistered = new Promise<string>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('Controller registration timeout')), 15_000);
    let output = '';
    const onData = (data: Buffer) => {
      output += data.toString();
      const match = output.match(/Controller registered: (\w+)/);
      if (match) {
        clearTimeout(timer);
        resolvePromise(match[1]);
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
    const res = await gqlRequest(CONTROLLER_QUERY, { id: controllerId }, token);
    const body = await res.json();
    if (body.data?.controller?.status === 'online') return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Controller did not come online');
}

async function waitForSessionStatus(sessionId: string, expected: string, token: string, timeoutMs = 60_000): Promise<string> {
  for (let i = 0; i < timeoutMs / 500; i++) {
    const res = await gqlRequest(SESSION_QUERY, { id: sessionId }, token);
    const body = await res.json();
    const status = body.data?.session?.status;
    if (status === expected) return status;
    if (status === 'ended' || status === 'removed') {
      throw new Error(`Session unexpected status: ${status}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Session did not reach status '${expected}' within ${timeoutMs}ms`);
}

/** 在 controller 日志缓冲中等待匹配行出现 */
async function waitForControllerLog(pattern: RegExp, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = controllerLogLines.find((l) => pattern.test(l));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function dumpMcpLogs(): void {
  console.log('[test] ---- captured agent-controller MCP log lines ----');
  for (const line of controllerLogLines.filter((l) => l.includes('[MCP'))) {
    console.log(`[test] ${line}`);
  }
  console.log('[test] ----------------------------------------------------');
}

describe('ACP Real: 普通会话装配 agent-workflow-admin-tools（下游打回复现）', () => {
  let controllerProcess: ChildProcess | null = null;
  let rawKey = '';
  let controllerId = '';
  let authToken = '';
  let adminServerId = '';
  let configBackup: string | null = null;

  beforeAll(async () => {
    cleanupPidFile();
    configBackup = backupConfig();

    const uid = `acp_admin_${Date.now().toString(36)}`;
    const res = await gqlRequest(SIGNUP, { username: uid, password: 'testpass123' });
    const body = await res.json();
    authToken = body.data?.signup?.token;
    expect(authToken).toBeTruthy();

    const keyRes = await gqlRequest(CREATE_KEY, { input: { name: `admin-real-${Date.now()}`, type: 'local' } }, authToken);
    const keyBody = await keyRes.json();
    rawKey = keyBody.data.createControllerKey.rawKey;
    expect(rawKey).toBeTruthy();

    // 触发 ensureAdminToolsServer（与前端 NewSessionDialog 的 GET_MCP_SERVERS 同路径）
    const mcpRes = await gqlRequest(MCP_SERVERS_QUERY, undefined, authToken);
    const mcpBody = await mcpRes.json();
    const admin = (mcpBody.data?.mcpServers ?? []).find(
      (s: { name: string; enabled: boolean }) => s.name === ADMIN_SERVER_NAME && s.enabled,
    );
    expect(admin, 'mcpServers 中应存在已启用的 agent-workflow-admin-tools').toBeTruthy();
    adminServerId = admin.id;
    console.log(`[test] admin tools server id: ${adminServerId}`);

    writeControllerConfig(rawKey, CONTROLLER_API_URL);
    const { process: proc, waitForRegistered } = spawnController();
    controllerProcess = proc;
    controllerId = await waitForRegistered;
    await waitForControllerOnline(controllerId, authToken);
    console.log(`[test] real agent-controller online: ${controllerId}`);
  }, 60_000);

  afterAll(async () => {
    if (controllerProcess) {
      controllerProcess.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
    }
    cleanupPidFile();
    restoreConfig(configBackup);
  });

  it('agent 经回环 relay 完成 admin-tools MCP 握手（initialize + tools/list 均 200）', async () => {
    const wsRes = await gqlRequest(
      CREATE_WORKSPACE,
      { input: { controllerId, path: `/tmp/acp-admin-tools-${Date.now()}` } },
      authToken,
    );
    const wsBody = await wsRes.json();
    const workspaceId = wsBody.data.createWorkspace.id;

    const sessionRes = await gqlRequest(
      CREATE_SESSION,
      { input: { controllerId, acpServerType: 'opencode', workspaceId, mcpServerIds: [adminServerId] } },
      authToken,
    );
    const sessionBody = await sessionRes.json();
    expect(sessionBody.errors).toBeUndefined();
    const sessionId = sessionBody.data.createSession.session.id;
    console.log(`[test] session created with admin tools: ${sessionId}`);

    await waitForSessionStatus(sessionId, 'idling', authToken, 90_000);
    console.log(`[test] session idling (agent ready)`);

    // opencode 应在 session/new 后初始化 MCP client：initialize → notifications/initialized → tools/list
    let toolsListLine = await waitForControllerLog(
      new RegExp(`\\[MCP local\\] ${sessionId}/${ADMIN_SERVER_NAME} tools/list -> 200`),
      30_000,
    );

    if (!toolsListLine) {
      // 部分 agent 可能惰性初始化 MCP：发一条提示词触发工具使用
      console.log('[test] 未观察到 eager tools/list，发送提示词触发 MCP 使用…');
      await gqlRequest(
        SEND_SESSION_MESSAGE,
        {
          sessionId,
          content:
            '请调用 MCP 工具 listWorkflowTemplates（server: agent-workflow-admin-tools），' +
            '然后原样回复工具返回内容；如果该工具不存在，仅回复 TOOL_MISSING。',
        },
        authToken,
      );
      toolsListLine = await waitForControllerLog(
        new RegExp(`\\[MCP local\\] ${sessionId}/${ADMIN_SERVER_NAME} tools/list -> 200`),
        120_000,
      );

      // 同时捞出 agent 的回答，辅助判断工具是否对模型可见
      await new Promise((r) => setTimeout(r, 5000));
      const msgRes = await gqlRequest(SESSION_MESSAGES_QUERY, { sessionId, limit: 30 }, authToken);
      const msgBody = await msgRes.json();
      const outputs = (msgBody.data?.sessionMessages ?? [])
        .filter((m: { direction: string }) => m.direction === 'output')
        .map((m: { content: unknown }) => JSON.stringify(m.content).slice(0, 500));
      console.log(`[test] agent output messages:\n${outputs.join('\n')}`);
    }

    dumpMcpLogs();
    expect(
      toolsListLine,
      '真实 agent 应对 agent-workflow-admin-tools 完成 tools/list 且回环 relay 返回 200；' +
        '若缺失请结合上方 [MCP local]/[MCP relay] 日志与 `aspire logs agent-api` / `aspire logs controller-api` 定位断点',
    ).toBeTruthy();
  }, 300_000);
});
