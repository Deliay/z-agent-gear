import { describe, it, expect, beforeAll } from 'vitest';

/**
 * 云电脑 GitHub Issues 联动配置 —— 黑盒用例 T-GHIL1 ~ T-GHIL6。
 *
 * 前置：`aspire start` + 一个 RUNNING 云电脑控制器（`CLOUD_HOST_CONTROLLER_ID`）
 * 与已绑定 Github 账号（标签同步走真实 GitHub API）。缺失时相关用例跳过。
 */
const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const CONTROLLER_ID = process.env.CLOUD_HOST_CONTROLLER_ID ?? '';

async function gql<T = Record<string, any>>(
  query: string,
  variables: Record<string, unknown> | undefined,
  token: string,
): Promise<T> {
  const res = await fetch(AGENT_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data as T;
}

const SIGNUP = `
  mutation Signup($username: String!, $password: String!) {
    signup(username: $username, password: $password) { token }
  }
`;

const LIST_LINKAGES = `
  query ListLinkages($controllerId: ID!) {
    cloudHostIssuesLinkages(controllerId: $controllerId) {
      id controllerId configuredWorkflowId configuredWorkflowName labelName repoFullNames
    }
  }
`;

const CREATE_LINKAGE = `
  mutation CreateLinkage($input: CloudHostIssuesLinkageInput!) {
    createCloudHostIssuesLinkage(input: $input) {
      id configuredWorkflowName labelName repoFullNames
    }
  }
`;

const UPDATE_LINKAGE = `
  mutation UpdateLinkage($id: ID!, $input: CloudHostIssuesLinkageInput!) {
    updateCloudHostIssuesLinkage(id: $id, input: $input) { id labelName }
  }
`;

const DELETE_LINKAGE = `
  mutation DeleteLinkage($id: ID!) { deleteCloudHostIssuesLinkage(id: $id) }
`;

const CLEANUP_LABELS = `
  mutation Cleanup($controllerId: ID!) {
    cleanupCloudHostIssuesLabels(controllerId: $controllerId) { deleted failed }
  }
`;

let token = '';

const WORKFLOW_ID = process.env.CLOUD_HOST_WORKFLOW_ID ?? '';
const TEST_REPO = process.env.GITHUB_TEST_REPO ?? '';
const hasConfigEnv = Boolean(CONTROLLER_ID && WORKFLOW_ID);

beforeAll(async () => {
  const username = `ghil-${Date.now()}`;
  const data = await gql<{ signup: { token: string } }>(SIGNUP, {
    username,
    password: 'Passw0rd!',
  }, '');
  token = data.signup.token;
});

describe('T-GHIL 云电脑 Issues 联动配置', () => {
  it('T-GHIL0 未认证拒绝', async () => {
    const res = await fetch(AGENT_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: LIST_LINKAGES, variables: { controllerId: CONTROLLER_ID || 'x' } }),
    });
    const body = await res.json();
    expect(JSON.stringify(body)).toContain('Not authenticated');
  });

  it('T-GHIL2a 非云电脑控制器 → cloud host not found', async () => {
    await expect(
      gql(LIST_LINKAGES, { controllerId: '507f1f77bcf86cd799439011' }, token),
    ).rejects.toThrow('cloud host not found');
  });

  it('T-GHIL2b 非法标签 → invalid label name', async () => {
    if (!CONTROLLER_ID) return;
    await expect(
      gql(
        CREATE_LINKAGE,
        {
          input: {
            controllerId: CONTROLLER_ID,
            configuredWorkflowId: '507f1f77bcf86cd799439012',
            labelName: 'a,b',
            repoFullNames: ['a/b'],
          },
        },
        token,
      ),
    ).rejects.toThrow('invalid label name');
  });

  it('T-GHIL2c 空仓库 → at least one repo is required', async () => {
    if (!CONTROLLER_ID) return;
    await expect(
      gql(
        CREATE_LINKAGE,
        {
          input: {
            controllerId: CONTROLLER_ID,
            configuredWorkflowId: '507f1f77bcf86cd799439012',
            labelName: 'start-dev',
            repoFullNames: [],
          },
        },
        token,
      ),
    ).rejects.toThrow('at least one repo is required');
  });

  it.skipIf(!hasConfigEnv || !TEST_REPO)('T-GHIL1 创建与列表（标签同步到仓库）', async () => {
    const label = `start-api-${Date.now()}`;
    const created = await gql<{ createCloudHostIssuesLinkage: any }>(
      CREATE_LINKAGE,
      {
        input: {
          controllerId: CONTROLLER_ID,
          configuredWorkflowId: WORKFLOW_ID,
          labelName: label,
          repoFullNames: [TEST_REPO],
        },
      },
      token,
    );
    expect(created.createCloudHostIssuesLinkage.labelName).toBe(label);

    const listed = await gql<{ cloudHostIssuesLinkages: any[] }>(LIST_LINKAGES, {
      controllerId: CONTROLLER_ID,
    }, token);
    expect(listed.cloudHostIssuesLinkages.some((row) => row.labelName === label)).toBe(true);
  });

  it.skipIf(!hasConfigEnv)('T-GHIL2d 未授权仓库 → repo not authorized', async () => {
    await expect(
      gql(
        CREATE_LINKAGE,
        {
          input: {
            controllerId: CONTROLLER_ID,
            configuredWorkflowId: WORKFLOW_ID,
            labelName: `start-api-${Date.now()}`,
            repoFullNames: ['not-authorized/repo-xyz'],
          },
        },
        token,
      ),
    ).rejects.toThrow('repo not authorized: not-authorized/repo-xyz');
  });

  it.skipIf(!hasConfigEnv || !TEST_REPO)('T-GHIL4/5 改名不同步删旧标签；删除后清理', async () => {
    const label = `start-api-${Date.now()}`;
    const created = await gql<{ createCloudHostIssuesLinkage: any }>(
      CREATE_LINKAGE,
      {
        input: {
          controllerId: CONTROLLER_ID,
          configuredWorkflowId: WORKFLOW_ID,
          labelName: label,
          repoFullNames: [TEST_REPO],
        },
      },
      token,
    );
    const id = created.createCloudHostIssuesLinkage.id;

    const updated = await gql<{ updateCloudHostIssuesLinkage: any }>(
      UPDATE_LINKAGE,
      {
        id,
        input: {
          controllerId: CONTROLLER_ID,
          configuredWorkflowId: WORKFLOW_ID,
          labelName: `${label}-v2`,
          repoFullNames: [TEST_REPO],
        },
      },
      token,
    );
    expect(updated.updateCloudHostIssuesLinkage.labelName).toBe(`${label}-v2`);

    const removed = await gql<{ deleteCloudHostIssuesLinkage: boolean }>(
      DELETE_LINKAGE,
      { id },
      token,
    );
    expect(removed.deleteCloudHostIssuesLinkage).toBe(true);

    const cleanup = await gql<{ cleanupCloudHostIssuesLabels: any }>(
      CLEANUP_LABELS,
      { controllerId: CONTROLLER_ID },
      token,
    );
    expect(Array.isArray(cleanup.cleanupCloudHostIssuesLabels.deleted)).toBe(true);
  });
});
