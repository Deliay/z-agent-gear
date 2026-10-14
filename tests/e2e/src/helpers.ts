import { io as SocketIOClient, type Socket } from 'socket.io-client';
import { createServer } from 'node:http';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

export const DEFAULT_ADMIN_PASSWORD = 'admin1234567';

/**
 * 将内置管理员重置为「默认密码 + 首次强制改密」（T-E1 真实首登链路）。
 * 需要 MONGODB_URI（aspire 注入的共享 Mongo）；缺失时返回 false，调用方跳过。
 */
export async function resetAdminToDefaultPassword(): Promise<boolean> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return false;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) return false;
  const passwordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
  await db.collection('admin_users').updateOne(
    { username: 'admin' },
    { $set: { passwordHash, mustChangePassword: true } },
    { upsert: true },
  );
  return true;
}

/** 直接把管理员密码设为指定值并解除强制改密（用于测试后恢复）。 */
export async function forceAdminPassword(password: string): Promise<boolean> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return false;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) return false;
  const passwordHash = await bcrypt.hash(password, 10);
  await db.collection('admin_users').updateOne(
    { username: 'admin' },
    { $set: { passwordHash, mustChangePassword: false } },
  );
  return true;
}

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const ADMIN_API_URL = process.env.ADMIN_API_URL || 'http://localhost:10003/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

export const ADMIN_TEST_PASSWORD = 'AdminTestPass123';
export const ADMIN_WEB_URL = process.env.ADMIN_WEB_URL || process.env.BASE_URL || 'http://localhost:35273';

export function adminGqlRequest(page: import('@playwright/test').Page, query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;
  return page.request.post(ADMIN_API_URL, { headers, data: body });
}

async function adminLoginWithPassword(page: import('@playwright/test').Page, password: string) {
  const res = await adminGqlRequest(page, `
    mutation AdminLogin($username: String!, $password: String!) {
      adminLogin(username: $username, password: $password) {
        token admin { mustChangePassword }
      }
    }
  `, { username: 'admin', password });
  const body = await res.json();
  return body.data?.adminLogin as { token: string; admin: { mustChangePassword: boolean } } | undefined;
}

/**
 * 归一化管理员密码到 ADMIN_TEST_PASSWORD 并返回可用 token（mustChangePassword=false）。
 * 与 tests/api 的 ensureAdminLogin 行为一致，使 E2E 可重复执行。
 */
export async function adminLoginApi(page: import('@playwright/test').Page): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let payload = await adminLoginWithPassword(page, ADMIN_TEST_PASSWORD);
    if (!payload) payload = await adminLoginWithPassword(page, DEFAULT_ADMIN_PASSWORD);
    if (!payload) {
      await page.waitForTimeout(500);
      continue;
    }
    if (!payload.admin.mustChangePassword) return payload.token;

    const changed = await adminGqlRequest(page, `
      mutation ChangeAdminPassword($oldPassword: String!, $newPassword: String!) {
        changeAdminPassword(oldPassword: $oldPassword, newPassword: $newPassword) {
          token admin { mustChangePassword }
        }
      }
    `, { oldPassword: DEFAULT_ADMIN_PASSWORD, newPassword: ADMIN_TEST_PASSWORD }, payload.token);
    const changedBody = await changed.json();
    if (changedBody.data?.changeAdminPassword) return changedBody.data.changeAdminPassword.token;
    await page.waitForTimeout(500);
  }
  throw new Error('adminLoginApi failed to normalize admin credentials');
}

/** 通过 UI 登录管理后台；先经 API 归一化密码，确保落在 /models。 */
export async function adminLoginViaUI(page: import('@playwright/test').Page) {
  await adminLoginApi(page); // 归一化到 admin / ADMIN_TEST_PASSWORD（mustChangePassword=false）
  await page.goto(`${ADMIN_WEB_URL}/login`);
  await page.fill('#username', 'admin');
  await page.fill('#password', ADMIN_TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/models', { timeout: 15000 });
}


export async function gqlRequest(page: import('@playwright/test').Page, query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;
  return page.request.post(API_URL, { headers, data: body });
}

export async function registerUser(page: import('@playwright/test').Page): Promise<{ token: string; username: string }> {
  const username = `eu${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
  const res = await gqlRequest(page, `
    mutation Signup($username: String!, $password: String!) {
      signup(username: $username, password: $password) { token user { id username } }
    }
  `, { username, password: 'testpass123' });
  const body = await res.json();
  return { token: body.data.signup.token, username };
}

export async function createControllerKey(page: import('@playwright/test').Page, token: string): Promise<{ rawKey: string }> {
  const res = await gqlRequest(page, `
    mutation CreateKey($input: CreateKeyInput!) {
      createControllerKey(input: $input) { rawKey key { id } }
    }
  `, { input: { name: `e2e-key-${Date.now()}`, type: 'local' } }, token);
  const body = await res.json();
  return { rawKey: body.data.createControllerKey.rawKey };
}

export interface FakeController {
  controllerId: string;
  disconnect: () => void;
  socket: Socket;
}

export function registerController(rawKey: string): Promise<FakeController> {
  return new Promise((resolve, reject) => {
    const client = SocketIOClient(CONTROLLER_API_URL, { transports: ['websocket'], reconnection: false, forceNew: true });
    const timer = setTimeout(() => { client.disconnect(); reject(new Error('Timeout')); }, 10000);

    // Handle acp:check - respond with available ACP servers
    client.on('acp:check', (data: { requestId: string }) => {
      client.emit('acp:check:result', {
        requestId: data.requestId,
        servers: [{ type: 'opencode', available: true, version: '1.0.0' }],
      });
    });

    // Handle git:worktree:list - 首页聚合查询会按工作区扇出 Worktree 列表，需即时应答避免阻塞首屏
    client.on('git:worktree:list', (data: { requestId: string }) => {
      client.emit('git:worktree:list:result', {
        requestId: data.requestId,
        success: true,
        worktrees: [],
      });
    });

    client.once('registered', (data: { controllerId: string }) => {
      clearTimeout(timer);
      resolve({ controllerId: data.controllerId, disconnect: () => client.disconnect(), socket: client });
    });
    client.once('error', (data: { code: string; message: string }) => {
      clearTimeout(timer);
      client.disconnect();
      reject(new Error(`Failed: ${data.message}`));
    });
    client.emit('register', {
      key: rawKey,
      hostname: 'e2e-host',
      version: '2.0.0',
      homeDir: '/home/fake',
      platform: 'linux',
    });
  });
}

export async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('button[type="submit"]');
  await page.locator('nav[aria-label="Sidebar"]').waitFor({ timeout: 10000 });
}

export async function createWorkspace(page: import('@playwright/test').Page, controllerId: string, path: string, token: string): Promise<{ id: string }> {
  const res = await gqlRequest(page, `
    mutation CreateWorkspace($input: CreateWorkspaceInput!) {
      createWorkspace(input: $input) { id name path }
    }
  `, { input: { controllerId, path } }, token);
  const body = await res.json();
  return body.data.createWorkspace;
}

export async function createSession(page: import('@playwright/test').Page, controllerId: string, token: string, workspaceId: string): Promise<string> {
  const res = await gqlRequest(page, `
    mutation CreateSession($input: CreateSessionInput!) {
      createSession(input: $input) { session { id } }
    }
  `, { input: { controllerId, acpServerType: 'opencode', workspaceId } }, token);
  const body = await res.json();
  return body.data.createSession.session.id;
}

// ---------------------------------------------------------------------------
// admin 套件：mock LLM 供应商 endpoint（拉取模型列表用）
// ---------------------------------------------------------------------------
export interface MockLlmServer {
  port: number;
  close: () => Promise<void>;
}

const FAKE_OPENAI_MODELS = ['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'];

export function startMockLlmServer(): Promise<MockLlmServer> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      if ((url === '/v1/models' || url === '/models') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: FAKE_OPENAI_MODELS.map((id) => ({ id, object: 'model', created: 1715368187, owned_by: 'openai' })),
        }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

export const MOCK_OPENAI_MODELS = FAKE_OPENAI_MODELS;

