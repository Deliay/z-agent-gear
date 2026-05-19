import { io as SocketIOClient, type Socket } from 'socket.io-client';

const API_URL = process.env.API_URL || 'http://localhost:4000/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';

export async function gqlRequest(page: import('@playwright/test').Page, query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;
  return page.request.post(API_URL, { headers, data: body });
}

export async function registerUser(page: import('@playwright/test').Page): Promise<{ token: string; username: string }> {
  const username = `e2e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
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
    client.once('registered', (data: { controllerId: string }) => {
      clearTimeout(timer);
      resolve({ controllerId: data.controllerId, disconnect: () => client.disconnect(), socket: client });
    });
    client.once('error', (data: { code: string; message: string }) => {
      clearTimeout(timer);
      client.disconnect();
      reject(new Error(`Failed: ${data.message}`));
    });
    client.emit('register', { key: rawKey, hostname: 'e2e-host', version: '1.0.0' });
  });
}

export async function loginViaUI(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.fill('#username', username);
  await page.fill('#password', 'testpass123');
  await page.click('button[type="submit"]');
  await page.locator('nav[aria-label="Sidebar"]').waitFor({ timeout: 10000 });
}

export async function createSession(page: import('@playwright/test').Page, controllerId: string, token: string): Promise<string> {
  const res = await gqlRequest(page, `
    mutation CreateSession($input: CreateSessionInput!) {
      createSession(input: $input) { session { id } }
    }
  `, { input: { controllerId, acpServerType: 'opencode' } }, token);
  const body = await res.json();
  return body.data.createSession.session.id;
}
