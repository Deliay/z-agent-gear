import { describe, it, expect, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import { createFrontUser, type FrontUser } from '../support/front-users.js';

/**
 * Valut 契约全链路集成测试（MCP+Valut Phase 5 / 计划测试矩阵 API-VAL）。
 *
 * - T-VAL5 权限矩阵：全局工作区 developer 读通写拒（`global workspace is read-only`）/
 *   admin 写通；普通工作区成员读写通；非成员（header 指向团队工作区）`workspace not found`、
 *   跨工作区 id `Not found`、不存在 id `valut entry not found`；
 * - T-VAL6 `valutManualOptions` 仅 manual 且仅当前工作区（跨工作区 id 猜测不可越权）；
 * - T-VAL7 GraphQL 响应任意路径无 value 明文（含错误分支），可选直读 Mongo 断言库内无明文；
 * - 契约全链路：create/list（namespace 聚合 + refs 展开）/update/delete 与校验白名单逐字。
 *
 * 前置：agent-api 就绪 + `INTERNAL_API_TOKEN`（开户）；`MONGODB_URI` 可选（库内明文断言）。
 * 契约：`contracts/valut.graphql`（错误白名单逐字，见契约头注释）。
 */

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const AGENT_API_BASE = API_URL.replace(/\/graphql\/?$/, '');
const HAS_MONGO = Boolean(process.env.MONGODB_URI);

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

async function internalJson(
  path: string,
  method: 'POST' | 'DELETE',
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) throw new Error('valut API tests require INTERNAL_API_TOKEN');
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
    // 保留原始文本便于排查
  }
  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------------------
// GraphQL 文档（契约 contracts/valut.graphql；选择集显式无 value 字段）
// ---------------------------------------------------------------------------

const VALUT_ENTRIES = `
  query ValutEntries {
    valutEntries {
      namespace { name displayName managed }
      entries {
        id namespace namespaceDisplayName key editable deletable
        refs { feature refId refLabel createdAt }
        createdBy createdAt updatedAt
      }
    }
  }
`;

const VALUT_MANUAL_OPTIONS = `
  query ValutManualOptions {
    valutManualOptions {
      id namespace namespaceDisplayName key editable deletable
      refs { feature refId refLabel createdAt }
      createdBy createdAt updatedAt
    }
  }
`;

const CREATE_VALUT = `
  mutation CreateValutEntry($input: CreateValutEntryInput!) {
    createValutEntry(input: $input) {
      id namespace namespaceDisplayName key editable deletable
      refs { feature refId refLabel createdAt }
      createdBy createdAt updatedAt
    }
  }
`;

const UPDATE_VALUT = `
  mutation UpdateValutEntry($id: ID!, $value: String!) {
    updateValutEntry(id: $id, value: $value) {
      id namespace namespaceDisplayName key editable deletable
      refs { feature refId refLabel createdAt }
      createdBy createdAt updatedAt
    }
  }
`;

const DELETE_VALUT = `
  mutation DeleteValutEntry($id: ID!) { deleteValutEntry(id: $id) }
`;

const CREATE_CUSTOM_MCP = `
  mutation CreateCustomMcpServer($input: CreateCustomMcpServerInput!) {
    createCustomMcpServer(input: $input) {
      id name endpoint authType bearerEntryId bearerEntryManaged workspaceId
    }
  }
`;

const DELETE_CUSTOM_MCP = `
  mutation DeleteCustomMcpServer($id: ID!) { deleteCustomMcpServer(id: $id) }
`;

const CREATE_TENANT_WORKSPACE = `
  mutation CreateTenantWorkspace($name: String!) {
    createTenantWorkspace(name: $name) { id name type }
  }
`;

const ADD_TENANT_WORKSPACE_MEMBER = `
  mutation AddTenantWorkspaceMember($workspaceId: ID!, $userId: ID!) {
    addTenantWorkspaceMember(workspaceId: $workspaceId, userId: $userId) { id memberCount }
  }
`;

// ---------------------------------------------------------------------------
// 断言助手
// ---------------------------------------------------------------------------

function findGroup(groups: any[], name: string): any | undefined {
  return groups.find((group) => group?.namespace?.name === name);
}

function findEntry(groups: any[], id: string): any | undefined {
  for (const group of groups ?? []) {
    const hit = (group?.entries ?? []).find((entry: { id: string }) => entry.id === id);
    if (hit) return hit;
  }
  return undefined;
}

function collectStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out);
  } else if (node && typeof node === 'object') {
    for (const item of Object.values(node)) collectStrings(item, out);
  }
  return out;
}

/** 响应任意路径（含 errors）不得出现 value 明文。 */
function expectNoPlaintext(payload: unknown, sentinel: string): void {
  for (const text of collectStrings(payload)) {
    expect(text, `plaintext leaked in response: ${text.slice(0, 200)}`).not.toContain(sentinel);
  }
}

/** ValutEntry 视图对象不得携带 value / valueEncrypted 字段。 */
function expectNoValueField(entry: unknown): void {
  expect(entry).toBeTypeOf('object');
  const keys = Object.keys(entry as Record<string, unknown>);
  expect(keys).not.toContain('value');
  expect(keys).not.toContain('valueEncrypted');
}

// ---------------------------------------------------------------------------
// 夹具：team 租户（admin/developer/outsider）+ 普通工作区（T-WS 模式）
// ---------------------------------------------------------------------------

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

let admin: FrontUser;
let developer: FrontUser;
let outsider: FrontUser;
let teamId = '';
let teamGlobalId = '';
let normalWorkspaceId = '';

/** T-VAL6/REFS 夹具（普通工作区，developer 创建）。 */
let manualEntryId = '';
let globalManualEntryId = '';
let managedMcpId = '';
let managedBearerEntryId = '';
/** T-VAL5 中 admin 在全局工作区创建的条目（跨工作区对照）。 */
let globalEntryId = '';

describe('Valut API（API-VAL / T-VAL5~7）', () => {
  beforeAll(async () => {
    admin = await createFrontUser();
    developer = await createFrontUser();
    outsider = await createFrontUser();

    const team = await internalJson('/internal/tenants', 'POST', { name: `valut-${suffix}`.slice(0, 60) });
    expect(team.status, JSON.stringify(team.body)).toBe(201);
    teamId = team.body.tenant.id;
    teamGlobalId = team.body.globalWorkspace.id;

    for (const [username, role] of [
      [admin.username, 'admin'],
      [developer.username, 'developer'],
    ] as const) {
      const added = await internalJson(`/internal/tenants/${teamId}/members`, 'POST', { username, role });
      expect([200, 201], JSON.stringify(added.body)).toContain(added.status);
    }

    const created = await gql(
      CREATE_TENANT_WORKSPACE,
      { name: `valut-normal-${suffix}` },
      admin.token,
      teamGlobalId,
    );
    expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
    normalWorkspaceId = created.data.createTenantWorkspace.id;

    const joined = await gql(
      ADD_TENANT_WORKSPACE_MEMBER,
      { workspaceId: normalWorkspaceId, userId: developer.userId },
      admin.token,
      teamGlobalId,
    );
    expect(joined.errors, JSON.stringify(joined.errors)).toBeUndefined();
  }, 120_000);

  it('T-VAL0: 未认证一律 Not authenticated（Query/Mutation 全入口）', async () => {
    const probes: Array<[string, Record<string, unknown> | undefined]> = [
      [VALUT_ENTRIES, undefined],
      [VALUT_MANUAL_OPTIONS, undefined],
      [CREATE_VALUT, { input: { key: `auth-${suffix}`, value: 'x' } }],
      [UPDATE_VALUT, { id: '000000000000000000000000', value: 'x' }],
      [DELETE_VALUT, { id: '000000000000000000000000' }],
    ];
    for (const [query, variables] of probes) {
      const res = await gql(query, variables);
      expect(res.errors?.[0]?.message).toBe('Not authenticated');
    }
  });

  it('T-VAL1: 手动条目全链路（create/list/update/delete）与校验白名单逐字', async () => {
    const key = `e2e-key-${suffix}`;
    // 个人租户默认上下文（无 x-workspace-id）
    const created = await gql(CREATE_VALUT, { input: { key, value: 'initial-secret' } }, outsider.token);
    expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
    const entry = created.data.createValutEntry;
    expect(entry).toMatchObject({
      namespace: 'manual',
      namespaceDisplayName: '自定义密钥',
      key,
      editable: true,
      deletable: true,
      createdBy: outsider.userId,
    });
    expect(entry.refs).toEqual([]);
    expectNoValueField(entry);
    const entryId = entry.id as string;

    // 重 key / 非法 key / 非法 value：契约白名单逐字
    const duplicate = await gql(CREATE_VALUT, { input: { key, value: 'again' } }, outsider.token);
    expect(duplicate.errors?.[0]?.message).toBe('valut key already exists');

    for (const badKey of ['bad key', 'bad\tkey', '', '   ']) {
      const invalidKey = await gql(CREATE_VALUT, { input: { key: badKey, value: 'x' } }, outsider.token);
      expect(invalidKey.errors?.[0]?.message).toBe('invalid valut key');
    }

    for (const badValue of ['', 'x'.repeat(16385)]) {
      const invalidValue = await gql(CREATE_VALUT, { input: { key: `vk-${suffix}-${badValue.length}`, value: badValue } }, outsider.token);
      expect(invalidValue.errors?.[0]?.message).toBe('invalid valut value');
    }

    // list：manual 组在前（非托管优先），条目可见
    const list = await gql(VALUT_ENTRIES, undefined, outsider.token);
    expect(list.errors, JSON.stringify(list.errors)).toBeUndefined();
    const manualGroup = findGroup(list.data.valutEntries, 'manual');
    expect(manualGroup).toBeDefined();
    expect(manualGroup.namespace.displayName).toBe('自定义密钥');
    expect(manualGroup.namespace.managed).toBe(false);
    expect(list.data.valutEntries[0].namespace.name).toBe('manual');
    expect(findEntry(list.data.valutEntries, entryId)).toBeDefined();

    // update：仅重写值，key 不可改
    const updated = await gql(UPDATE_VALUT, { id: entryId, value: 'rotated-secret' }, outsider.token);
    expect(updated.errors, JSON.stringify(updated.errors)).toBeUndefined();
    expect(updated.data.updateValutEntry.key).toBe(key);
    expectNoValueField(updated.data.updateValutEntry);

    const invalidUpdate = await gql(UPDATE_VALUT, { id: entryId, value: '' }, outsider.token);
    expect(invalidUpdate.errors?.[0]?.message).toBe('invalid valut value');

    // delete → true；再次删除/更新 → valut entry not found
    const deleted = await gql(DELETE_VALUT, { id: entryId }, outsider.token);
    expect(deleted.errors, JSON.stringify(deleted.errors)).toBeUndefined();
    expect(deleted.data.deleteValutEntry).toBe(true);

    const afterDelete = await gql(VALUT_ENTRIES, undefined, outsider.token);
    expect(findEntry(afterDelete.data.valutEntries, entryId)).toBeUndefined();

    const deleteAgain = await gql(DELETE_VALUT, { id: entryId }, outsider.token);
    expect(deleteAgain.errors?.[0]?.message).toBe('valut entry not found');
    const updateAgain = await gql(UPDATE_VALUT, { id: entryId, value: 'x' }, outsider.token);
    expect(updateAgain.errors?.[0]?.message).toBe('valut entry not found');
  });

  it('T-VAL5: 权限矩阵 —— 全局 developer 读通写拒 / admin 写通；普通工作区成员读写通；非成员与跨工作区', async () => {
    // 1) 全局工作区：developer 读通
    const devRead = await gql(VALUT_ENTRIES, undefined, developer.token, teamGlobalId);
    expect(devRead.errors, JSON.stringify(devRead.errors)).toBeUndefined();
    expect(Array.isArray(devRead.data.valutEntries)).toBe(true);

    // 2) 全局工作区：developer 一切写拒（白名单逐字）
    const devCreate = await gql(
      CREATE_VALUT,
      { input: { key: `dev-g-${suffix}`, value: 'x' } },
      developer.token,
      teamGlobalId,
    );
    expect(devCreate.errors?.[0]?.message).toBe('global workspace is read-only');

    // 3) 全局工作区：admin 写通（create/update）
    const adminCreate = await gql(
      CREATE_VALUT,
      { input: { key: `admin-g-${suffix}`, value: 'global-value' } },
      admin.token,
      teamGlobalId,
    );
    expect(adminCreate.errors, JSON.stringify(adminCreate.errors)).toBeUndefined();
    globalEntryId = adminCreate.data.createValutEntry.id as string;
    expectNoValueField(adminCreate.data.createValutEntry);

    const adminUpdate = await gql(
      UPDATE_VALUT,
      { id: globalEntryId, value: 'global-value-2' },
      admin.token,
      teamGlobalId,
    );
    expect(adminUpdate.errors, JSON.stringify(adminUpdate.errors)).toBeUndefined();

    // developer 全局 update/delete 同样拒
    const devUpdate = await gql(UPDATE_VALUT, { id: globalEntryId, value: 'x' }, developer.token, teamGlobalId);
    expect(devUpdate.errors?.[0]?.message).toBe('global workspace is read-only');
    const devDelete = await gql(DELETE_VALUT, { id: globalEntryId }, developer.token, teamGlobalId);
    expect(devDelete.errors?.[0]?.message).toBe('global workspace is read-only');

    // 4) 普通工作区：成员（developer）读写通，且能看到 admin 创建的条目
    const devNormalCreate = await gql(
      CREATE_VALUT,
      { input: { key: `dev-n-${suffix}`, value: 'normal-value' } },
      developer.token,
      normalWorkspaceId,
    );
    expect(devNormalCreate.errors, JSON.stringify(devNormalCreate.errors)).toBeUndefined();
    const normalEntryId = devNormalCreate.data.createValutEntry.id as string;

    const devNormalRead = await gql(VALUT_ENTRIES, undefined, developer.token, normalWorkspaceId);
    expect(devNormalRead.errors, JSON.stringify(devNormalRead.errors)).toBeUndefined();
    expect(findEntry(devNormalRead.data.valutEntries, normalEntryId)).toBeDefined();

    const adminNormalRead = await gql(VALUT_ENTRIES, undefined, admin.token, normalWorkspaceId);
    expect(adminNormalRead.errors, JSON.stringify(adminNormalRead.errors)).toBeUndefined();
    expect(findEntry(adminNormalRead.data.valutEntries, normalEntryId)).toBeDefined();

    const devNormalUpdate = await gql(
      UPDATE_VALUT,
      { id: normalEntryId, value: 'normal-value-2' },
      developer.token,
      normalWorkspaceId,
    );
    expect(devNormalUpdate.errors, JSON.stringify(devNormalUpdate.errors)).toBeUndefined();

    // 5) 非成员（outsider）：header 指向团队工作区一律 workspace not found（不泄露存在性）
    const outsiderGlobal = await gql(VALUT_ENTRIES, undefined, outsider.token, teamGlobalId);
    expect(outsiderGlobal.errors?.[0]?.message).toBe('workspace not found');
    const outsiderCreate = await gql(
      CREATE_VALUT,
      { input: { key: `out-${suffix}`, value: 'x' } },
      outsider.token,
      normalWorkspaceId,
    );
    expect(outsiderCreate.errors?.[0]?.message).toBe('workspace not found');

    // 6) 跨工作区 id：存在但不在当前工作区 → Not found（存在性探针）
    const crossToNormal = await gql(
      UPDATE_VALUT,
      { id: globalEntryId, value: 'x' },
      admin.token,
      normalWorkspaceId,
    );
    expect(crossToNormal.errors?.[0]?.message).toBe('Not found');
    const crossToGlobal = await gql(DELETE_VALUT, { id: normalEntryId }, admin.token, teamGlobalId);
    expect(crossToGlobal.errors?.[0]?.message).toBe('Not found');

    // 列表口径：独占型（仅当前工作区）
    const globalList = await gql(VALUT_ENTRIES, undefined, admin.token, teamGlobalId);
    expect(findEntry(globalList.data.valutEntries, normalEntryId)).toBeUndefined();
    expect(findEntry(globalList.data.valutEntries, globalEntryId)).toBeDefined();
    const normalList = await gql(VALUT_ENTRIES, undefined, admin.token, normalWorkspaceId);
    expect(findEntry(normalList.data.valutEntries, globalEntryId)).toBeUndefined();
    expect(findEntry(normalList.data.valutEntries, normalEntryId)).toBeDefined();

    // 7) 不存在 id → valut entry not found
    const missing = await gql(
      UPDATE_VALUT,
      { id: '000000000000000000000000', value: 'x' },
      admin.token,
      teamGlobalId,
    );
    expect(missing.errors?.[0]?.message).toBe('valut entry not found');
  });

  it('T-VAL6: valutManualOptions 仅 manual 且仅当前工作区；service 条目 deletable=false 拒删', async () => {
    // 普通工作区：developer 建 manual 条目
    const manual = await gql(
      CREATE_VALUT,
      { input: { key: `manual-${suffix}`, value: 'manual-secret' } },
      developer.token,
      normalWorkspaceId,
    );
    expect(manual.errors, JSON.stringify(manual.errors)).toBeUndefined();
    manualEntryId = manual.data.createValutEntry.id as string;

    // 普通工作区：bearer + newToken 的自建 token 条目（落 service-mcp-bearer-tokens）
    const bearerToken = `CMCP_BEARER_${suffix}`;
    const mcp = await gql(
      CREATE_CUSTOM_MCP,
      {
        input: {
          name: `cmcp-managed-${suffix}`,
          endpoint: 'http://127.0.0.1:9/mcp',
          auth: { type: 'bearer', newToken: bearerToken },
        },
      },
      developer.token,
      normalWorkspaceId,
    );
    expect(mcp.errors, JSON.stringify(mcp.errors)).toBeUndefined();
    managedMcpId = mcp.data.createCustomMcpServer.id as string;
    managedBearerEntryId = mcp.data.createCustomMcpServer.bearerEntryId as string;
    expect(managedBearerEntryId).toBeTruthy();
    expect(mcp.data.createCustomMcpServer.bearerEntryManaged).toBe(true);
    expectNoPlaintext(mcp, bearerToken);

    // 全局工作区（admin）manual 条目：跨工作区对照
    const globalManual = await gql(
      CREATE_VALUT,
      { input: { key: `global-manual-${suffix}`, value: 'global-manual-value' } },
      admin.token,
      teamGlobalId,
    );
    expect(globalManual.errors, JSON.stringify(globalManual.errors)).toBeUndefined();
    globalManualEntryId = globalManual.data.createValutEntry.id as string;

    // 当前工作区（普通）：仅 manual、仅本工作区
    const options = await gql(VALUT_MANUAL_OPTIONS, undefined, developer.token, normalWorkspaceId);
    expect(options.errors, JSON.stringify(options.errors)).toBeUndefined();
    const optionIds = options.data.valutManualOptions.map((row: { id: string }) => row.id);
    expect(optionIds).toContain(manualEntryId);
    expect(optionIds).not.toContain(globalManualEntryId); // 跨工作区不可见
    expect(optionIds).not.toContain(managedBearerEntryId); // 仅 manual（service 条目排除）
    expect(
      options.data.valutManualOptions.every((row: { namespace: string }) => row.namespace === 'manual'),
    ).toBe(true);
    options.data.valutManualOptions.forEach(expectNoValueField);

    // 全局上下文（admin）：含全局 manual、不含普通工作区条目与 service 条目
    const globalOptions = await gql(VALUT_MANUAL_OPTIONS, undefined, admin.token, teamGlobalId);
    expect(globalOptions.errors, JSON.stringify(globalOptions.errors)).toBeUndefined();
    const globalOptionIds = globalOptions.data.valutManualOptions.map((row: { id: string }) => row.id);
    expect(globalOptionIds).toContain(globalManualEntryId);
    expect(globalOptionIds).not.toContain(manualEntryId);
    expect(globalOptionIds).not.toContain(managedBearerEntryId);

    // service 分组：managed=true、displayName=MCP Bearer Tokens、deletable=false 拒删
    const groups = await gql(VALUT_ENTRIES, undefined, developer.token, normalWorkspaceId);
    expect(groups.errors, JSON.stringify(groups.errors)).toBeUndefined();
    const serviceGroup = findGroup(groups.data.valutEntries, 'service-mcp-bearer-tokens');
    expect(serviceGroup, 'service-mcp-bearer-tokens 分组应存在').toBeDefined();
    expect(serviceGroup.namespace.displayName).toBe('MCP Bearer Tokens');
    expect(serviceGroup.namespace.managed).toBe(true);
    const serviceEntry = serviceGroup.entries.find((row: { id: string }) => row.id === managedBearerEntryId);
    expect(serviceEntry).toBeDefined();
    expect(serviceEntry).toMatchObject({ editable: true, deletable: false, key: `cmcp-managed-${suffix}` });
    expectNoValueField(serviceEntry);

    const deleteService = await gql(DELETE_VALUT, { id: managedBearerEntryId }, developer.token, normalWorkspaceId);
    expect(deleteService.errors?.[0]?.message).toBe('valut entry is not deletable');
  });

  it('T-VAL-REFS: refs 展开、manual 有 refs 拒删、引用删除仅解绑、自建 token 删除级联', async () => {
    // 引用 manual 条目（existingEntryId 路径：仅建 ref）
    const refName = `cmcp-ref-${suffix}`;
    const refMcp = await gql(
      CREATE_CUSTOM_MCP,
      {
        input: {
          name: refName,
          endpoint: 'http://127.0.0.1:9/mcp',
          auth: { type: 'bearer', existingEntryId: manualEntryId },
        },
      },
      developer.token,
      normalWorkspaceId,
    );
    expect(refMcp.errors, JSON.stringify(refMcp.errors)).toBeUndefined();
    const refMcpId = refMcp.data.createCustomMcpServer.id as string;
    expect(refMcp.data.createCustomMcpServer.bearerEntryManaged).toBe(false);

    // valutEntries 中 refs 展开（feature 不带 service- 前缀）
    const groups = await gql(VALUT_ENTRIES, undefined, developer.token, normalWorkspaceId);
    expect(groups.errors, JSON.stringify(groups.errors)).toBeUndefined();
    const referenced = findEntry(groups.data.valutEntries, manualEntryId);
    expect(referenced).toBeDefined();
    expect(referenced.refs).toHaveLength(1);
    expect(referenced.refs[0]).toMatchObject({
      feature: 'mcp-bearer-tokens',
      refId: refMcpId,
      refLabel: refName,
    });
    expect(typeof referenced.refs[0].createdAt).toBe('string');

    // manual 条目存在 refs → 拒删（白名单逐字）
    const blocked = await gql(DELETE_VALUT, { id: manualEntryId }, developer.token, normalWorkspaceId);
    expect(blocked.errors?.[0]?.message).toBe('valut entry has refs');

    // 引用路径删除 MCP → 仅删 ref，manual 条目保留
    const deleteRefMcp = await gql(DELETE_CUSTOM_MCP, { id: refMcpId }, developer.token, normalWorkspaceId);
    expect(deleteRefMcp.errors, JSON.stringify(deleteRefMcp.errors)).toBeUndefined();
    expect(deleteRefMcp.data.deleteCustomMcpServer).toBe(true);

    const afterRef = await gql(VALUT_ENTRIES, undefined, developer.token, normalWorkspaceId);
    const kept = findEntry(afterRef.data.valutEntries, manualEntryId);
    expect(kept, '引用删除后 manual 条目应保留').toBeDefined();
    expect(kept.refs).toHaveLength(0);

    const deleteManual = await gql(DELETE_VALUT, { id: manualEntryId }, developer.token, normalWorkspaceId);
    expect(deleteManual.errors, JSON.stringify(deleteManual.errors)).toBeUndefined();
    expect(deleteManual.data.deleteValutEntry).toBe(true);

    // 自建 token（service 条目）：删除 MCP → entry+ref 级联删除
    const deleteManaged = await gql(DELETE_CUSTOM_MCP, { id: managedMcpId }, developer.token, normalWorkspaceId);
    expect(deleteManaged.errors, JSON.stringify(deleteManaged.errors)).toBeUndefined();
    expect(deleteManaged.data.deleteCustomMcpServer).toBe(true);

    const afterCascade = await gql(VALUT_ENTRIES, undefined, developer.token, normalWorkspaceId);
    const serviceGroup = findGroup(afterCascade.data.valutEntries, 'service-mcp-bearer-tokens');
    const stillThere = serviceGroup
      ? serviceGroup.entries.find((row: { id: string }) => row.id === managedBearerEntryId)
      : undefined;
    expect(stillThere, '自建 token 条目应随 MCP 删除级联消失').toBeUndefined();
    // manual 对照条目（全局工作区）不受影响
    const globalList = await gql(VALUT_ENTRIES, undefined, admin.token, teamGlobalId);
    expect(findEntry(globalList.data.valutEntries, globalManualEntryId)).toBeDefined();
  });

  it('T-VAL7: GraphQL 响应任意路径无 value 明文（含错误分支）', async () => {
    const sentinel = `VALUT_PLAINTEXT_${suffix}_7`;
    const key = `plain-${suffix}`;
    const created = await gql(CREATE_VALUT, { input: { key, value: sentinel } }, outsider.token);
    expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
    const entryId = created.data.createValutEntry.id as string;
    expectNoPlaintext(created, sentinel);
    expectNoValueField(created.data.createValutEntry);

    // 成功读路径
    const list = await gql(VALUT_ENTRIES, undefined, outsider.token);
    expectNoPlaintext(list, sentinel);
    for (const group of list.data.valutEntries) {
      for (const entry of group.entries) expectNoValueField(entry);
    }
    const options = await gql(VALUT_MANUAL_OPTIONS, undefined, outsider.token);
    expectNoPlaintext(options, sentinel);

    // update 成功分支
    const updated = await gql(UPDATE_VALUT, { id: entryId, value: `${sentinel}-rotated` }, outsider.token);
    expect(updated.errors, JSON.stringify(updated.errors)).toBeUndefined();
    expectNoPlaintext(updated, sentinel);

    // 错误分支 1：重复 key（入参携带明文）
    const duplicate = await gql(CREATE_VALUT, { input: { key, value: sentinel } }, outsider.token);
    expect(duplicate.errors?.[0]?.message).toBe('valut key already exists');
    expectNoPlaintext(duplicate, sentinel);

    // 错误分支 2：不存在 id（入参携带明文）
    const missing = await gql(UPDATE_VALUT, { id: '000000000000000000000000', value: sentinel }, outsider.token);
    expect(missing.errors?.[0]?.message).toBe('valut entry not found');
    expectNoPlaintext(missing, sentinel);

    // 错误分支 3：非法 value（入参含明文但为空/超长）
    const invalidValue = await gql(UPDATE_VALUT, { id: entryId, value: '' }, outsider.token);
    expect(invalidValue.errors?.[0]?.message).toBe('invalid valut value');
    expectNoPlaintext(invalidValue, sentinel);
    const tooLong = await gql(
      UPDATE_VALUT,
      { id: entryId, value: `${sentinel}${'x'.repeat(16384)}` },
      outsider.token,
    );
    expect(tooLong.errors?.[0]?.message).toBe('invalid valut value');
    expectNoPlaintext(tooLong, sentinel);

    // 错误分支 4：跨工作区 Not found（入参携带明文）
    const cross = await gql(UPDATE_VALUT, { id: globalEntryId, value: sentinel }, admin.token, normalWorkspaceId);
    expect(cross.errors?.[0]?.message).toBe('Not found');
    expectNoPlaintext(cross, sentinel);

    // 错误分支 5：只读拦截（入参携带明文）
    const readOnly = await gql(UPDATE_VALUT, { id: globalEntryId, value: sentinel }, developer.token, teamGlobalId);
    expect(readOnly.errors?.[0]?.message).toBe('global workspace is read-only');
    expectNoPlaintext(readOnly, sentinel);

    // 错误分支 6：deletable=false 拒删（service 条目；同轮创建的 token 明文亦不得出现在响应中）
    const managedToken = `PLAINTOKEN_${sentinel}`;
    const managedMcp = await gql(
      CREATE_CUSTOM_MCP,
      {
        input: {
          name: `plain-managed-${suffix}`,
          endpoint: 'http://127.0.0.1:9/mcp',
          auth: { type: 'bearer', newToken: managedToken },
        },
      },
      outsider.token,
    );
    expect(managedMcp.errors, JSON.stringify(managedMcp.errors)).toBeUndefined();
    expectNoPlaintext(managedMcp, managedToken);
    const managedEntryId = managedMcp.data.createCustomMcpServer.bearerEntryId as string;

    const notDeletable = await gql(DELETE_VALUT, { id: managedEntryId }, outsider.token);
    expect(notDeletable.errors?.[0]?.message).toBe('valut entry is not deletable');
    expectNoPlaintext(notDeletable, sentinel);
    expectNoPlaintext(notDeletable, managedToken);

    await gql(DELETE_CUSTOM_MCP, { id: managedMcp.data.createCustomMcpServer.id }, outsider.token);

    // 可选：直读 Mongo 断言库内无明文（valueEncrypted 密文形态）
    if (HAS_MONGO) {
      if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI!);
      const doc = (await mongoose.connection.db!
        .collection('valutentries')
        .findOne({ key })) as Record<string, any> | null;
      expect(doc, '条目应落库').toBeTruthy();
      expect(doc!.valueEncrypted).toBeTruthy();
      expect(typeof doc!.valueEncrypted.iv).toBe('string');
      expect(typeof doc!.valueEncrypted.ciphertext).toBe('string');
      expect(typeof doc!.valueEncrypted.tag).toBe('string');
      expect(JSON.stringify(doc)).not.toContain(sentinel);
    }

    await gql(DELETE_VALUT, { id: entryId }, outsider.token);
  });
});
