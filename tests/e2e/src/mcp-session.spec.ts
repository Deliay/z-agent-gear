import { test, expect } from '@playwright/test';
import { registerUser, createControllerKey, registerController, createWorkspace, loginViaUI } from './helpers.js';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_API_URL = process.env.CONTROLLER_API_URL || 'http://localhost:4001';
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:10001';

async function gqlRequest(page: import('@playwright/test').Page, query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;
  return page.request.post(API_URL, { headers, data: body });
}

async function registerMcpProxy(page: import('@playwright/test').Page, token: string, rawKey: string, serverName: string): Promise<{ proxyId: string; serverId: string }> {
  const res = await page.request.post(`${CONTROLLER_API_URL}/api/mcp-proxy/register`, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      key: rawKey,
      hostname: 'e2e-machine',
      command: 'npx -y @modelcontextprotocol/server-everything',
      serverName,
    },
  });
  const body = await res.json();
  return body;
}

test.describe('MCP Session Integration (register → directory → select → create)', () => {
  test('registered proxy appears in MCP 目录 and can be selected in session creation', async ({ page }) => {
    const { token, username } = await registerUser(page);

    // Create a controller key and register a fake controller
    const { rawKey } = await createControllerKey(page, token);
    const controller = await registerController(rawKey);

    // Create a workspace for the controller
    const workspace = await createWorkspace(page, controller.controllerId, `/home/e2e/${Date.now()}`, token);

    // Create an MCP proxy key + register a mock proxy server
    const userId = JSON.parse(atob(token.split('.')[1])).userId;
    const keyRes = await page.request.post(`${CONTROLLER_API_URL}/api/mcp-proxy-keys`, {
      headers: { 'x-user-id': userId },
      data: { name: 'E2E Proxy Key' },
    });
    const keyData = await keyRes.json();
    const proxyRawKey = keyData.rawKey;

    const reg = await registerMcpProxy(page, token, proxyRawKey, 'e2e-everything-mcp');
    expect(reg.success).toBe(true);
    expect(reg.serverId).toBeDefined();

    // Directory page should list the registered server
    await loginViaUI(page, username);
    await page.goto('/settings');
    await expect(page.getByText('MCP 目录', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('e2e-everything-mcp')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('代理注册')).toBeVisible({ timeout: 10000 });

    // Listen for acp:start on the fake controller BEFORE creating the session
    const acpStart = new Promise<{ requestId: string; sessionId: string; mcpEndpoint?: { url: string; token: string; serverNames: string[] } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for acp:start')), 10000);
      controller.socket.once('acp:start', (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

    // Create session via GraphQL with mcpServerIds selected
    const createRes = await gqlRequest(page, `
      mutation CreateSession($input: CreateSessionInput!) {
        createSession(input: $input) { session { id status } }
      }
    `, {
      input: {
        controllerId: controller.controllerId,
        acpServerType: 'opencode',
        workspaceId: workspace.id,
        mcpServerIds: [reg.serverId],
      },
    }, token);
    const createData = await createRes.json();
    expect(createData.data.createSession.session.id).toBeDefined();

    // The agent-controller receives acp:start with a complete mcpEndpoint
    // (url + token + serverNames); a missing serverNames field previously
    // crashed the agent bridge with an undiagnosable TypeError.
    const startData = await acpStart;
    expect(startData.sessionId).toBe(createData.data.createSession.session.id);
    expect(startData.mcpEndpoint).toBeDefined();
    expect(startData.mcpEndpoint!.url).toContain(`/mcp/${startData.sessionId}`);
    expect(startData.mcpEndpoint!.token).toBeTruthy();
    expect(startData.mcpEndpoint!.serverNames).toEqual(['e2e-everything-mcp']);

    controller.disconnect();
  });

  test('MCP entry rejects unauthenticated requests', async ({ request }) => {
    const res = await request.post(`${GATEWAY_URL}/mcp/some-session`, {
      headers: { 'Content-Type': 'application/json' },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(res.status()).toBe(401);
  });
});
