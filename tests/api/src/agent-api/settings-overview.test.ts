import { describe, it, expect, beforeAll } from 'vitest';
import { createFrontUser, uniqueFrontUsername } from '../support/front-users.js';

const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const AGENT_API_BASE = AGENT_API_URL.replace(/\/graphql\/?$/, '');

function gqlRequest(
  query: string,
  variables?: Record<string, unknown>,
  token?: string,
  workspaceId?: string,
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (workspaceId) headers['x-workspace-id'] = workspaceId;
  const body: Record<string, unknown> = { query };
  if (variables) body.variables = variables;
  return fetch(AGENT_API_URL, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function gqlData<T>(
  query: string,
  variables?: Record<string, unknown>,
  token?: string,
  workspaceId?: string,
): Promise<T> {
  const res = await gqlRequest(query, variables, token, workspaceId);
  const body = await res.json();
  expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
  return body.data as T;
}

async function internalProv(
  path: string,
  method: 'POST',
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) throw new Error('T-SET requires INTERNAL_API_TOKEN');
  const res = await fetch(`${AGENT_API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 保留原文便于排查
  }
  return { status: res.status, body: parsed };
}

const SETTINGS_OVERVIEW = `
  query SettingsOverview {
    settingsOverview {
      commitSettings { committerType customName customEmail commitWithBot }
      providers { id name type endpoint credentialType isEnabled scope workspaceId }
      models { id providerId name isCustom isEnabled sortOrder contextLength scope workspaceId }
      controllerKeys { id name type keyPrefix status rawKey lastUsedAt }
      mcpServers { id name transport source enabled status }
      valutEntries { namespace { name displayName managed } entries { id key editable deletable } }
      customMcpServers { id name endpoint authType bearerEntryManaged }
      customTools { id name type }
      githubAccounts { id githubUserId githubLogin workspaceId }
      githubAppUrl { url state }
      myExternalLogins { id providerId externalUsername }
      authProviders { id type displayName }
      cloudStorageCapabilities { enabled }
      cloudStorages { id name sizeGi status }
    }
  }
`;

const ORIGINAL_QUERIES: Record<string, string> = {
  commitSettings: `query Q { commitSettings { committerType customName customEmail commitWithBot } }`,
  providers: `query Q { providers { id name type endpoint credentialType isEnabled scope workspaceId } }`,
  models: `query Q { models { id providerId name isCustom isEnabled sortOrder contextLength scope workspaceId } }`,
  controllerKeys: `query Q { controllerKeys { id name type keyPrefix status rawKey lastUsedAt } }`,
  mcpServers: `query Q { mcpServers { id name transport source enabled status } }`,
  valutEntries: `query Q { valutEntries { namespace { name displayName managed } entries { id key editable deletable } } }`,
  customMcpServers: `query Q { customMcpServers { id name endpoint authType bearerEntryManaged } }`,
  customTools: `query Q { customTools { id name type } }`,
  githubAccounts: `query Q { githubAccounts { id githubUserId githubLogin workspaceId } }`,
  githubAppUrl: `query Q { githubAppUrl { url state } }`,
  myExternalLogins: `query Q { myExternalLogins { id providerId externalUsername } }`,
  authProviders: `query Q { authProviders { id type displayName } }`,
  cloudStorageCapabilities: `query Q { cloudStorageCapabilities { enabled } }`,
  cloudStorages: `query Q { cloudStorages { id name sizeGi status } }`,
};

let token = '';
let username = '';

describe('SettingsOverview API（T-SET）', () => {
  beforeAll(async () => {
    const user = await createFrontUser(uniqueFrontUsername('set'));
    token = user.token;
    username = user.username;
  });

  it('T-SET1 settingsOverview 14 分支与直查原查询逐字段一致', async () => {
    const overview = await gqlData<{ settingsOverview: Record<string, any> }>(
      SETTINGS_OVERVIEW,
      undefined,
      token,
    );

    for (const [branch, query] of Object.entries(ORIGINAL_QUERIES)) {
      const direct = await gqlData<Record<string, any>>(query, undefined, token);
      if (branch === 'githubAppUrl') {
        // state 一次性随机，逐字段比较 url 形态与 state 非空
        expect(typeof overview.settingsOverview.githubAppUrl.url).toBe('string');
        expect(typeof overview.settingsOverview.githubAppUrl.state).toBe('string');
        expect(direct.githubAppUrl.url).toMatch(/^https?:\/\//);
        expect(direct.githubAppUrl.state.length).toBeGreaterThan(0);
        continue;
      }
      expect(overview.settingsOverview[branch], `branch=${branch}`).toEqual(direct[branch]);
    }
  });

  it('T-SET2 单分支失败不拖垮整页：只读上下文 githubAppUrl 降级，其余分支正常返回', async () => {
    const teamName = `set-team-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.slice(0, 60);
    const team = await internalProv('/internal/tenants', 'POST', { name: teamName });
    expect(team.status, JSON.stringify(team.body)).toBe(201);
    const teamId = team.body.tenant.id;
    const teamGlobalId = team.body.globalWorkspace.id;

    const added = await internalProv(`/internal/tenants/${teamId}/members`, 'POST', {
      username,
      role: 'developer',
    });
    expect([200, 201], JSON.stringify(added.body)).toContain(added.status);

    // 全局工作区 + developer = 只读：githubAppUrl 分支降级为空值，其余 13 分支仍返回
    const data = await gqlData<{ settingsOverview: Record<string, any> }>(
      SETTINGS_OVERVIEW,
      undefined,
      token,
      teamGlobalId,
    );
    expect(data.settingsOverview.githubAppUrl).toEqual({ url: '', state: '' });
    expect(Array.isArray(data.settingsOverview.providers)).toBe(true);
    expect(Array.isArray(data.settingsOverview.models)).toBe(true);
    expect(Array.isArray(data.settingsOverview.controllerKeys)).toBe(true);
    expect(Array.isArray(data.settingsOverview.mcpServers)).toBe(true);
    expect(Array.isArray(data.settingsOverview.valutEntries)).toBe(true);
    expect(Array.isArray(data.settingsOverview.customMcpServers)).toBe(true);
    expect(Array.isArray(data.settingsOverview.customTools)).toBe(true);
    expect(Array.isArray(data.settingsOverview.githubAccounts)).toBe(true);
    expect(Array.isArray(data.settingsOverview.myExternalLogins)).toBe(true);
    expect(Array.isArray(data.settingsOverview.authProviders)).toBe(true);
    expect(data.settingsOverview.commitSettings).toBeTruthy();
    expect(data.settingsOverview.cloudStorageCapabilities).toBeTruthy();
    expect(Array.isArray(data.settingsOverview.cloudStorages)).toBe(true);
  });
});
