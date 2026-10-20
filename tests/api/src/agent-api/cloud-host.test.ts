import { describe, it, expect } from 'vitest';

// 前台云电脑 API（需要 Aspire 全量服务 + HARNESS_ENABLED=true）。
// `K8S_ENABLED=false` 下 create 只能停在 STARTING；在线/默认会话由单测与真实集群验收覆盖。
const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const HARNESS_ENABLED = process.env.HARNESS_ENABLED === 'true';

function gql(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  }).then((res) => res.json() as Promise<{ data?: any; errors?: Array<{ message: string }> }>);
}

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) { token user { id } }
  }
`;

const CAPABILITIES = `query { cloudHostCapabilities { enabled supportedHarnesses } }`;

const MY_HOSTS = `
  query {
    myCloudHosts {
      id name controllerId status harnessTypes defaultSessionId activeSessionCount
      containerId createdAt readyAt stoppedAt failureReason deletedAt
    }
  }
`;

const CREATE = `
  mutation CreateCloudHost($input: CreateCloudHostInput!) {
    createCloudHost(input: $input) {
      id name controllerId status harnessTypes defaultSessionId activeSessionCount
    }
  }
`;

const STOP_IMPACT = `query Impact($id: ID!) { cloudHostStopImpact(id: $id) { activeSessionCount sessionsWillBeLost sessions { id title status acpServerType } } }`;

const STOP = `mutation Stop($id: ID!, $force: Boolean) { stopCloudHost(id: $id, force: $force) { id status stoppedAt } }`;

const DELETE = `mutation Delete($id: ID!) { deleteCloudHost(id: $id) }`;

const HOME = `query { homeOverview { controllers { id type name cloudHost { id status } } } }`;

async function signup(): Promise<string> {
  const username = `ch${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
  const result = await gql(SIGNUP, { username, password: 'password123' });
  return result.data.signup.token as string;
}

describe.skipIf(!HARNESS_ENABLED)('Cloud Host API', () => {
  it('T-CH1: capabilities exposes OPENCODE when enabled', async () => {
    const token = await signup();
    const result = await gql(CAPABILITIES, undefined, token);
    expect(result.errors).toBeUndefined();
    expect(result.data.cloudHostCapabilities).toEqual({
      enabled: true,
      supportedHarnesses: ['OPENCODE'],
    });
  });

  it('T-CH3/T-CH4: validates name and harnessTypes', async () => {
    const token = await signup();
    const emptyName = await gql(CREATE, { input: { name: '   ', harnessTypes: ['OPENCODE'] } }, token);
    expect(emptyName.errors?.[0].message).toBe('name is required');

    const longName = await gql(
      CREATE,
      { input: { name: 'x'.repeat(65), harnessTypes: ['OPENCODE'] } },
      token,
    );
    expect(longName.errors?.[0].message).toBe('name is too long');

    const noHarness = await gql(CREATE, { input: { name: 'cloud', harnessTypes: [] } }, token);
    expect(noHarness.errors?.[0].message).toBe('at least one harness type is required');
  });

  it('T-CH7/T-CH10/T-CH11: create/list/owner isolation/1 instance/stop/delete', async () => {
    const token = await signup();
    const other = await signup();

    const created = await gql(
      CREATE,
      { input: { name: `cloud-${Date.now().toString(36)}`, harnessTypes: ['OPENCODE'] } },
      token,
    );
    expect(created.errors).toBeUndefined();
    const host = created.data.createCloudHost;
    expect(host).toMatchObject({
      status: 'STARTING',
      harnessTypes: ['OPENCODE'],
      activeSessionCount: 0,
    });

    const second = await gql(CREATE, { input: { name: 'another', harnessTypes: ['OPENCODE'] } }, token);
    expect(second.errors?.[0].message).toBe('too many cloud hosts');

    const mine = await gql(MY_HOSTS, undefined, token);
    expect(mine.data.myCloudHosts.map((item: { id: string }) => item.id)).toContain(host.id);

    const theirs = await gql(MY_HOSTS, undefined, other);
    expect(theirs.data.myCloudHosts.map((item: { id: string }) => item.id)).not.toContain(host.id);

    const foreignStop = await gql(STOP, { id: host.id, force: true }, other);
    expect(foreignStop.errors?.[0].message).toBe('Cloud host not found');

    // Controller.cloudHost：cloud 主机返回最新映射
    const home = await gql(HOME, undefined, token);
    const controller = home.data.homeOverview.controllers.find(
      (item: { id: string }) => item.id === host.controllerId,
    );
    expect(controller).toMatchObject({ type: 'cloud', cloudHost: { id: host.id } });

    const impact = await gql(STOP_IMPACT, { id: host.id }, token);
    expect(impact.data.cloudHostStopImpact).toMatchObject({
      activeSessionCount: 0,
      sessionsWillBeLost: false,
      sessions: [],
    });

    const stopped = await gql(STOP, { id: host.id, force: false }, token);
    expect(stopped.errors).toBeUndefined();
    expect(stopped.data.stopCloudHost.status).toBe('STOPPED');

    // 幂等
    await expect(gql(STOP, { id: host.id }, token)).resolves.toMatchObject({
      data: { stopCloudHost: { status: 'STOPPED' } },
    });

    const deleted = await gql(DELETE, { id: host.id }, token);
    expect(deleted.data.deleteCloudHost).toBe(true);
    await expect(gql(DELETE, { id: host.id }, token)).resolves.toMatchObject({
      data: { deleteCloudHost: true },
    });

    const afterDelete = await gql(MY_HOSTS, undefined, token);
    expect(afterDelete.data.myCloudHosts.map((item: { id: string }) => item.id)).not.toContain(
      host.id,
    );

    // 软删除后 Controller.cloudHost 为 null
    const homeAfter = await gql(HOME, undefined, token);
    const offlined = homeAfter.data.homeOverview.controllers.find(
      (item: { id: string }) => item.id === host.controllerId,
    );
    expect(offlined?.cloudHost ?? null).toBeNull();
  });

  it('T-CH28: all entries require authentication', async () => {
    for (const [query, variables] of [
      [CAPABILITIES, undefined],
      [MY_HOSTS, undefined],
      [STOP_IMPACT, { id: '000000000000000000000000' }],
      [CREATE, { input: { name: 'x', harnessTypes: ['OPENCODE'] } }],
      [DELETE, { id: '000000000000000000000000' }],
    ] as Array<[string, Record<string, unknown> | undefined]>) {
      const result = await gql(query, variables);
      expect(result.errors?.[0].message).toBe('Not authenticated');
    }
  });
});
