import { describe, it, expect, beforeAll } from 'vitest';
import { createFrontUser, type FrontUser } from '../support/front-users.js';

/**
 * 自定义工具 API 集成测试（需求 #449 / 计划测试矩阵 API-CT）。
 *
 * 覆盖：CRUD 全链路、校验白名单逐字、重名拒绝、跨工作区 `Not found`、不存在 id 文案。
 * 前置：agent-api 就绪（Aspire）+ `INTERNAL_API_TOKEN`（开户）。契约：
 * `contracts/custom-tool.graphql`。
 *
 * 说明：MCP 动态目录与 tools/call 的 wire 级行为由 agent-api 单测
 * （`custom-tools-mcp.test.ts` / `custom-tool-http.test.ts`）覆盖；E2E 覆盖设置页 UI。
 */

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';

type GqlResult = { data?: any; errors?: Array<{ message: string }> };

async function gql(
  query: string,
  variables?: Record<string, unknown>,
  token?: string,
  workspaceId?: string,
): Promise<GqlResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (workspaceId) headers['x-workspace-id'] = workspaceId;
  const res = await fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as GqlResult;
}

const CREATE_WORKSPACE = `
  mutation CreateTenantWorkspace($name: String!) {
    createTenantWorkspace(name: $name) { id name type }
  }
`;

const CREATE_TOOL = `
  mutation CreateCustomTool($input: CreateCustomToolInput!) {
    createCustomTool(input: $input) {
      id name description type workspaceId
      args { key name description }
      prompt { type value format }
      http { method endpoint { type value format } insecure bodyType headers { key value { type value format } } queries { key value { type value format } } }
      createdAt updatedAt
    }
  }
`;

const UPDATE_TOOL = `
  mutation UpdateCustomTool($id: ID!, $input: UpdateCustomToolInput!) {
    updateCustomTool(id: $id, input: $input) { id name args { key } prompt { type value format } }
  }
`;

const DELETE_TOOL = `
  mutation DeleteCustomTool($id: ID!) { deleteCustomTool(id: $id) }
`;

const LIST_TOOLS = `
  query CustomTools {
    customTools { id name type args { key } }
  }
`;

const GET_TOOL = `
  query CustomTool($id: ID!) { customTool(id: $id) { id name } }
`;

function promptInput(name: string) {
  return {
    name,
    description: 'E2E 测试工具',
    type: 'prompt',
    args: [
      { key: 'city', name: '目标城市', description: '城市名' },
      { key: 'month', name: '月份', description: null },
    ],
    prompt: [
      { type: 'Plain', value: 'https://foo.bar/', format: 'Generic' },
      { type: 'Parameter', value: 'city', format: 'Uri' },
      { type: 'Plain', value: '/weather/', format: 'Generic' },
      { type: 'Parameter', value: 'month', format: 'Generic' },
    ],
  };
}

let user: FrontUser;

beforeAll(async () => {
  user = await createFrontUser();
});

describe('Custom Tool API（API-CT）', () => {
  it('CRUD 全链路：创建 / 列表 / 单条 / 更新 / 删除', async () => {
    const name = `api-tool-${Date.now().toString(36)}`;
    const created = await gql(CREATE_TOOL, { input: promptInput(name) }, user.token);
    expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
    const tool = created.data.createCustomTool;
    expect(tool).toMatchObject({ name, type: 'prompt' });
    expect(tool.args).toHaveLength(2);
    expect(tool.prompt[1]).toEqual({ type: 'Parameter', value: 'city', format: 'Uri' });
    expect(tool.http).toBeNull();

    const list = await gql(LIST_TOOLS, undefined, user.token);
    expect(list.data.customTools.some((item: { id: string }) => item.id === tool.id)).toBe(true);

    const single = await gql(GET_TOOL, { id: tool.id }, user.token);
    expect(single.data.customTool).toMatchObject({ id: tool.id, name });

    const updated = await gql(
      UPDATE_TOOL,
      {
        id: tool.id,
        input: { name: `${name}-v2`, args: [{ key: 'city', name: '城市' }], prompt: [{ type: 'Parameter', value: 'city', format: 'Generic' }] },
      },
      user.token,
    );
    expect(updated.errors, JSON.stringify(updated.errors)).toBeUndefined();
    expect(updated.data.updateCustomTool.name).toBe(`${name}-v2`);

    const removed = await gql(DELETE_TOOL, { id: tool.id }, user.token);
    expect(removed.data.deleteCustomTool).toBe(true);
    const gone = await gql(GET_TOOL, { id: tool.id }, user.token);
    expect(gone.data.customTool).toBeNull();
  });

  it('校验白名单逐字透传：name/description/args/引用一致性/http', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...promptInput(''), name: '' }, 'invalid custom tool name'],
      [{ ...promptInput('x'), description: 'd'.repeat(513) }, 'invalid custom tool description'],
      [{ ...promptInput('x'), args: [{ key: '1bad', name: 'n' }] }, 'invalid custom tool args'],
      [
        { ...promptInput('x'), prompt: [{ type: 'Parameter', value: 'nope', format: 'Generic' }] },
        'invalid fragment template',
      ],
      [
        {
          name: 'x',
          type: 'http',
          args: [],
          http: { method: 'GET', endpoint: [{ type: 'Plain', value: 'https://x.example.com', format: 'Generic' }], insecure: false, bodyType: 'json', body: [{ type: 'Plain', value: '{}', format: 'Generic' }], headers: [], queries: [] },
        },
        'invalid http config',
      ],
    ];
    for (const [input, message] of cases) {
      const result = await gql(CREATE_TOOL, { input }, user.token);
      expect(result.errors?.[0]?.message).toBe(message);
    }
  });

  it('重名拒绝：duplicate custom tool name', async () => {
    const name = `dup-${Date.now().toString(36)}`;
    const first = await gql(CREATE_TOOL, { input: promptInput(name) }, user.token);
    expect(first.errors).toBeUndefined();
    const second = await gql(CREATE_TOOL, { input: promptInput(name) }, user.token);
    expect(second.errors?.[0]?.message).toBe('duplicate custom tool name');
    await gql(DELETE_TOOL, { id: first.data.createCustomTool.id }, user.token);
  });

  it('跨工作区不可见（Not found）；不存在 id → custom tool not found', async () => {
    const name = `iso-${Date.now().toString(36)}`;
    const created = await gql(CREATE_TOOL, { input: promptInput(name) }, user.token);
    const id = created.data.createCustomTool.id;

    const ws = await gql(CREATE_WORKSPACE, { name: `ct-ws-${Date.now().toString(36)}` }, user.token);
    expect(ws.errors, JSON.stringify(ws.errors)).toBeUndefined();
    const otherWorkspaceId = ws.data.createTenantWorkspace.id;

    const cross = await gql(DELETE_TOOL, { id }, user.token, otherWorkspaceId);
    expect(cross.errors?.[0]?.message).toBe('Not found');

    const missing = await gql(DELETE_TOOL, { id: '507f1f77bcf86cd799439999' }, user.token);
    expect(missing.errors?.[0]?.message).toBe('custom tool not found');

    await gql(DELETE_TOOL, { id }, user.token);
  });

  it('http 工具创建（body json / headers / queries）', async () => {
    const name = `http-${Date.now().toString(36)}`;
    const result = await gql(
      CREATE_TOOL,
      {
        input: {
          name,
          type: 'http',
          args: [{ key: 'city', name: '城市' }],
          http: {
            method: 'POST',
            endpoint: [
              { type: 'Plain', value: 'https://api.example.com/v1/', format: 'Generic' },
              { type: 'Parameter', value: 'city', format: 'Uri' },
            ],
            insecure: false,
            bodyType: 'json',
            body: [{ type: 'Plain', value: '{"city":"x"}', format: 'Generic' }],
            headers: [{ key: 'X-Token', value: [{ type: 'Plain', value: 'abc', format: 'Generic' }] }],
            queries: [{ key: 'q', value: [{ type: 'Parameter', value: 'city', format: 'Uri' }] }],
          },
        },
      },
      user.token,
    );
    expect(result.errors, JSON.stringify(result.errors)).toBeUndefined();
    expect(result.data.createCustomTool).toMatchObject({ name, type: 'http' });
    expect(result.data.createCustomTool.prompt).toBeNull();
    await gql(DELETE_TOOL, { id: result.data.createCustomTool.id }, user.token);
  });
});
