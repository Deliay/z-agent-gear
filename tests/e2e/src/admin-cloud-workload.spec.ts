import { test, expect, type Locator, type Page } from '@playwright/test';
import mongoose from 'mongoose';
import { ADMIN_WEB_URL, adminGqlRequest, adminLoginApi, adminLoginViaUI } from './helpers.js';

// 工作负载（Workload）E2E：T-E7~T-E13 / T-E16。
//
// 覆盖裁剪（计划裁决 12/17）：Aspire 以 K8S_ENABLED=false 启动、无真实工作容器回连，
// `INITIALIZING` 与脚本执行链路改由 cloud-controller/agent-controller 单测与 tests/api
// （直写 Mongo + 内部 API/GraphQL 查询）覆盖；本文件只覆盖可确定性链接：
//   - T-E7 工作负载 CRUD 全流程（新建/编辑/删除确认；删除后从启动选择列表消失）
//   - T-E8 启动对话框多选（默认不选、按勾选顺序）→ 容器行展示挂载名称
//   - T-E9 直写 Mongo 构造 INITIALIZING + currentWorkloadName → 页面展示「初始化中」+ 脚本名
//   - T-E10 直写 cloudworkloadlogs → 日志对话框展示阶段/状态/脚本快照/输出
//   - T-E11 未登录访问 /cloud-workloads 重定向登录
//   - T-E12 四种参数类型配置 → 保存 → 编辑回显；非法参数被拦截
//   - T-E13 多依赖配置与展示；依赖环被拦截
//   - T-E16 预制工作负载（Docker/Node.js/.NET/Aspire）与「预制」徽章

const WL_PREFIX = 'e2e-wl-';

interface ParamFieldNode {
  key: string;
  label: string;
  type: string;
  options: string[];
  defaultValue: unknown;
}

interface WorkloadNode {
  id: string;
  name: string;
  initScript: string | null;
  postScript: string | null;
  paramSchema?: ParamFieldNode[];
  dependsOnWorkloadIds?: string[];
  isPreset?: boolean;
}

interface ContainerNode {
  id: string;
  name: string;
  status: string;
  workloads: WorkloadNode[];
  currentWorkloadName: string | null;
}

interface ParamFieldInput {
  key: string;
  label: string;
  type: string;
  options?: string[];
  defaultValue: unknown;
}

async function listWorkloads(page: Page, token: string): Promise<WorkloadNode[]> {
  const res = await adminGqlRequest(
    page,
    `query {
      adminCloudWorkloads {
        id name initScript postScript
        paramSchema { key label type options defaultValue }
        dependsOnWorkloadIds
        isPreset
      }
    }`,
    undefined,
    token,
  );
  const body = await res.json();
  return (body.data?.adminCloudWorkloads ?? []) as WorkloadNode[];
}

async function createWorkload(
  page: Page,
  token: string,
  input: {
    name: string;
    initScript?: string | null;
    postScript?: string | null;
    paramSchema?: ParamFieldInput[];
    dependsOnWorkloadIds?: string[];
  },
): Promise<WorkloadNode> {
  const res = await adminGqlRequest(
    page,
    `mutation($input: CreateCloudWorkloadInput!) { adminCreateCloudWorkload(input: $input) { id name } }`,
    { input },
    token,
  );
  const body = await res.json();
  expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
  return body.data.adminCreateCloudWorkload as WorkloadNode;
}

/** 在参数设计器里填写第 index 个参数（类型切换会重置默认值，故先选类型再填可选项/默认值）。 */
async function fillParam(
  dialog: Locator,
  index: number,
  param: {
    key: string;
    label: string;
    typeLabel: string;
    options?: string;
    selectDefault?: string;
    multiDefault?: string;
    textDefault?: string;
    booleanDefault?: boolean;
  },
): Promise<void> {
  await dialog.locator(`#param-key-${index}`).fill(param.key);
  await dialog.locator(`#param-label-${index}`).fill(param.label);
  await dialog.locator(`#param-type-${index}`).selectOption({ label: param.typeLabel });
  if (param.options !== undefined) {
    await dialog.locator(`#param-options-${index}`).fill(param.options);
  }
  if (param.selectDefault !== undefined) {
    await dialog.locator(`#param-default-${index}`).selectOption(param.selectDefault);
  }
  if (param.multiDefault !== undefined) {
    await dialog.getByRole('checkbox', { name: param.multiDefault }).click();
  }
  if (param.textDefault !== undefined) {
    await dialog.locator(`#param-default-${index}`).fill(param.textDefault);
  }
  if (param.booleanDefault !== undefined) {
    await dialog.getByRole('switch', { name: '默认值' }).click();
  }
}

async function deleteWorkload(page: Page, token: string, id: string): Promise<void> {
  await adminGqlRequest(page, `mutation($id: ID!) { adminDeleteCloudWorkload(id: $id) }`, { id }, token);
}

/** 清理本套件创建的工作负载（按前缀），保证用例可重复执行。 */
async function cleanupWorkloads(page: Page, token: string): Promise<void> {
  const all = await listWorkloads(page, token);
  for (const workload of all.filter((w) => w.name.startsWith(WL_PREFIX))) {
    await deleteWorkload(page, token, workload.id);
  }
}

async function listContainers(page: Page, token: string): Promise<ContainerNode[]> {
  const res = await adminGqlRequest(
    page,
    `query { adminCloudContainers { id name status workloads { id name } currentWorkloadName } }`,
    undefined,
    token,
  );
  const body = await res.json();
  return (body.data?.adminCloudContainers ?? []) as ContainerNode[];
}

async function startContainer(page: Page, token: string, workloadIds: string[]): Promise<ContainerNode> {
  const res = await adminGqlRequest(
    page,
    `mutation($purpose: CloudContainerPurpose!, $workloadIds: [ID!]) {
      adminStartCloudContainer(purpose: $purpose, workloadIds: $workloadIds) {
        id name status workloads { id name } currentWorkloadName
      }
    }`,
    { purpose: 'IDLE', workloadIds },
    token,
  );
  const body = await res.json();
  expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
  return body.data.adminStartCloudContainer as ContainerNode;
}

async function destroyContainer(page: Page, token: string, id: string): Promise<void> {
  await adminGqlRequest(page, `mutation($id: ID!) { adminDestroyCloudContainer(id: $id) }`, { id }, token).catch(
    () => {},
  );
}

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  return mongoose.connection.db ?? null;
}

test.describe('Admin Cloud Workload E2E', () => {
  test('T-E7: creates, edits and deletes a workload via the UI', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupWorkloads(page, token);

    const name = `${WL_PREFIX}crud-${Date.now().toString(36)}`;
    const renamed = `${name}-v2`;

    await adminLoginViaUI(page);
    await page.getByRole('link', { name: /工作负载/ }).click();
    await expect(page).toHaveURL(/\/cloud-workloads/);
    await expect(page.getByRole('heading', { name: '工作负载' })).toBeVisible();

    // 新建（init + post 两个脚本）
    await page.getByRole('button', { name: '新建工作负载' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('#workload-name').fill(name);
    await dialog.locator('#workload-init-script').fill('echo init');
    await dialog.locator('#workload-post-script').fill('echo post');
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();

    // 编辑
    await page.getByRole('button', { name: `编辑 ${name}` }).click();
    const editDialog = page.getByRole('dialog');
    await expect(editDialog).toBeVisible();
    await editDialog.locator('#workload-name').fill(renamed);
    await editDialog.getByRole('button', { name: '保存' }).click();
    await expect(page.getByRole('cell', { name: renamed, exact: true })).toBeVisible();

    // 删除二次确认
    await page.getByRole('button', { name: `删除 ${renamed}` }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm.getByRole('heading', { name: '删除工作负载' })).toBeVisible();
    await confirm.getByRole('button', { name: '删除', exact: true }).click();
    await expect(page.getByRole('cell', { name: renamed, exact: true })).not.toBeVisible();
  });

  test('T-E7/T-E8: deleted workload disappears from the start selection list', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupWorkloads(page, token);

    const name = `${WL_PREFIX}gone-${Date.now().toString(36)}`;
    const workload = await createWorkload(page, token, { name, initScript: 'echo ok' });

    try {
      await adminLoginViaUI(page);
      await page.getByRole('link', { name: /云端容器/ }).click();
      await expect(page.getByRole('heading', { name: '云端容器' })).toBeVisible();

      // 出现在启动选择列表
      await page.getByRole('button', { name: '启动', exact: true }).click();
      let dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('checkbox', { name })).toBeVisible();
      await dialog.getByRole('button', { name: '取消' }).click();
      await expect(dialog).not.toBeVisible();

      // 在「工作负载」页经 UI 删除（触发 refetchQueries 刷新工作负载缓存）
      await page.getByRole('link', { name: /工作负载/ }).click();
      await expect(page).toHaveURL(/\/cloud-workloads/);
      await page.getByRole('button', { name: `删除 ${name}` }).click();
      const confirm = page.getByRole('dialog');
      await expect(confirm.getByRole('heading', { name: '删除工作负载' })).toBeVisible();
      await confirm.getByRole('button', { name: '删除', exact: true }).click();
      await expect(page.getByRole('cell', { name, exact: true })).not.toBeVisible();

      // 回到容器页，启动选择列表不再出现该工作负载
      await page.getByRole('link', { name: /云端容器/ }).click();
      await expect(page).toHaveURL(/\/cloud-containers/);
      await expect(page.getByRole('heading', { name: '云端容器' })).toBeVisible();

      await page.getByRole('button', { name: '启动', exact: true }).click();
      dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('checkbox', { name })).toHaveCount(0);
    } finally {
      await deleteWorkload(page, token, workload.id).catch(() => {});
    }
  });

  test('T-E8: start dialog multi-selects workloads and the container row lists them', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupWorkloads(page, token);

    const suffix = Date.now().toString(36);
    const a = await createWorkload(page, token, { name: `${WL_PREFIX}a-${suffix}`, initScript: 'echo a' });
    const b = await createWorkload(page, token, { name: `${WL_PREFIX}b-${suffix}`, postScript: 'echo b' });

    let containerId: string | null = null;
    try {
      await adminLoginViaUI(page);
      await page.getByRole('link', { name: /云端容器/ }).click();
      await expect(page.getByRole('heading', { name: '云端容器' })).toBeVisible();

      await page.getByRole('button', { name: '启动', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      // 默认不选；按勾选顺序（先 b 后 a）
      await expect(dialog.getByRole('checkbox', { name: a.name })).not.toBeChecked();
      await dialog.getByRole('checkbox', { name: b.name }).click();
      await dialog.getByRole('checkbox', { name: a.name }).click();
      await dialog.getByRole('button', { name: '确认启动' }).click();
      await expect(dialog).not.toBeVisible();

      // 轮询 API 找到新建容器并核对挂载顺序 = 勾选顺序 [b, a]
      let created: ContainerNode | undefined;
      for (let i = 0; i < 20 && !created; i += 1) {
        const now = await listContainers(page, token);
        created = now.find((c) => c.workloads.some((w) => w.id === b.id));
        if (!created) await page.waitForTimeout(500);
      }
      expect(created, 'newly started container should list the mounted workloads').toBeTruthy();
      containerId = created!.id;
      expect(created!.workloads.map((w) => w.id)).toEqual([b.id, a.id]);

      // UI 行展示挂载的工作负载名称
      const row = page.locator('tr', { hasText: created!.name }).first();
      await expect(row.getByText(a.name)).toBeVisible();
      await expect(row.getByText(b.name)).toBeVisible();
    } finally {
      if (containerId) await destroyContainer(page, token, containerId);
      await deleteWorkload(page, token, a.id);
      await deleteWorkload(page, token, b.id);
    }
  });

  test('T-E9: shows the initializing badge with the current workload name', async ({ page }) => {
    test.skip(!process.env.MONGODB_URI, 'MONGODB_URI 未提供，跳过直写 Mongo 构造 INITIALIZING');

    const token = await adminLoginApi(page);
    await cleanupWorkloads(page, token);

    const name = `${WL_PREFIX}init-${Date.now().toString(36)}`;
    const workload = await createWorkload(page, token, { name, initScript: 'echo init' });

    let containerId: string | null = null;
    try {
      const container = await startContainer(page, token, [workload.id]);
      containerId = container.id;

      // 构造 INITIALIZING + currentWorkloadName（裁决 17：无真实回连链路，直写 Mongo）
      const db = await mongoDb();
      expect(db).not.toBeNull();
      await db!.collection('cloudcontainers').updateOne(
        { _id: new mongoose.Types.ObjectId(container.id) },
        { $set: { status: 'initializing', currentWorkloadName: name, connectedAt: new Date() } },
      );

      await adminLoginViaUI(page);
      await page.getByRole('link', { name: /云端容器/ }).click();
      const row = page.locator('tr', { hasText: container.name }).first();
      await expect(row).toBeVisible();
      await expect(row.getByText('初始化中')).toBeVisible();
      // 名称同时出现在「当前脚本」与「工作负载」列（容器挂载了该工作负载），取首个即可
      await expect(row.getByText(name).first()).toBeVisible();
    } finally {
      if (containerId) await destroyContainer(page, token, containerId);
      await deleteWorkload(page, token, workload.id);
    }
  });

  test('T-E10: shows workload execution logs (phase/status/script snapshot/output)', async ({ page }) => {
    test.skip(!process.env.MONGODB_URI, 'MONGODB_URI 未提供，跳过直写 cloudworkloadlogs');

    const token = await adminLoginApi(page);
    const container = await startContainer(page, token, []);

    const db = await mongoDb();
    expect(db).not.toBeNull();
    const containerId = new mongoose.Types.ObjectId(container.id);
    const workloadId = new mongoose.Types.ObjectId();
    const base = Date.now() - 60_000;
    await db!.collection('cloudworkloadlogs').insertMany([
      {
        containerId,
        workloadId,
        workloadName: 'setup-node',
        phase: 'init',
        status: 'success',
        script: 'echo "hello init"',
        exitCode: 0,
        log: 'hello init\n',
        startedAt: new Date(base),
        finishedAt: new Date(base + 1000),
        createdAt: new Date(base),
        updatedAt: new Date(base + 1000),
      },
      {
        containerId,
        workloadId,
        workloadName: 'teardown',
        phase: 'post',
        status: 'failed',
        script: 'echo "cleanup"',
        exitCode: 2,
        log: 'cleanup failed\n',
        startedAt: new Date(base + 2000),
        finishedAt: new Date(base + 3000),
        createdAt: new Date(base + 2000),
        updatedAt: new Date(base + 3000),
      },
    ]);

    try {
      await adminLoginViaUI(page);
      await page.getByRole('link', { name: /云端容器/ }).click();
      const row = page.locator('tr', { hasText: container.name }).first();
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: `工作负载日志 ${container.name}` }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: '工作负载执行日志' })).toBeVisible();

      // 记录列表：工作负载/阶段/状态（默认选中第一条 = init success）
      await expect(dialog.getByRole('button', { name: '查看 setup-node 初始化' })).toBeVisible();
      await expect(dialog.getByText('初始化')).toBeVisible();
      await expect(dialog.getByText('成功')).toBeVisible();
      // 脚本快照 + 输出日志（exact 区分 script 快照与 log 输出，避免子串互相命中）
      await expect(dialog.getByText('脚本快照')).toBeVisible();
      await expect(dialog.getByText('echo "hello init"', { exact: true })).toBeVisible();
      await expect(dialog.getByText('hello init', { exact: true })).toBeVisible();

      // 切换到 post 记录：阶段/状态/脚本快照/输出同步更新
      await dialog.getByRole('button', { name: '查看 teardown 清理' }).click();
      await expect(dialog.getByText('清理', { exact: true })).toBeVisible();
      await expect(dialog.getByText('失败', { exact: true })).toBeVisible();
      await expect(dialog.getByText('echo "cleanup"', { exact: true })).toBeVisible();
      await expect(dialog.getByText('cleanup failed', { exact: true })).toBeVisible();
    } finally {
      await db!.collection('cloudworkloadlogs').deleteMany({ containerId });
      await destroyContainer(page, token, container.id);
    }
  });

  test('T-E11: unauthenticated access to /cloud-workloads is redirected to login', async ({ page }) => {
    await page.goto(`${ADMIN_WEB_URL}/cloud-workloads`);
    await expect(page).toHaveURL(/\/login/);
  });

  test('T-E12/T-E13: configures four param types and multiple dependencies, echoes on edit', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupWorkloads(page, token);

    const suffix = Date.now().toString(36);
    const depA = await createWorkload(page, token, { name: `${WL_PREFIX}dep-a-${suffix}`, initScript: 'echo a' });
    const depB = await createWorkload(page, token, { name: `${WL_PREFIX}dep-b-${suffix}`, initScript: 'echo b' });
    const name = `${WL_PREFIX}params-${suffix}`;

    try {
      await adminLoginViaUI(page);
      await page.getByRole('link', { name: /工作负载/ }).click();
      await expect(page).toHaveURL(/\/cloud-workloads/);
      await expect(page.getByRole('heading', { name: '工作负载' })).toBeVisible();

      await page.getByRole('button', { name: '新建工作负载' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.locator('#workload-name').fill(name);
      await dialog.locator('#workload-init-script').fill('echo params');

      // 四种参数类型
      for (let i = 0; i < 4; i += 1) {
        await dialog.getByRole('button', { name: '添加参数' }).click();
      }
      await fillParam(dialog, 0, {
        key: 'mode',
        label: '模式',
        typeLabel: '下拉单选',
        options: 'fast\nslow',
        selectDefault: 'fast',
      });
      await fillParam(dialog, 1, {
        key: 'features',
        label: '特性',
        typeLabel: '下拉多选',
        options: 'x1\nx2',
        multiDefault: 'x1',
      });
      await fillParam(dialog, 2, { key: 'version', label: '版本', typeLabel: '文本', textDefault: '22' });
      await fillParam(dialog, 3, {
        key: 'verbose',
        label: '详细',
        typeLabel: '布尔',
        booleanDefault: true,
      });

      // 多依赖（勾选顺序 = 初始化顺序）
      await dialog.getByRole('checkbox', { name: depA.name }).click();
      await dialog.getByRole('checkbox', { name: depB.name }).click();
      await expect(dialog.getByText(/已选依赖（按初始化顺序）：/)).toBeVisible();
      await expect(dialog.getByText(new RegExp(`${depA.name} → ${depB.name}`))).toBeVisible();

      await dialog.getByRole('button', { name: '保存' }).click();
      await expect(page.getByRole('cell', { name, exact: true })).toBeVisible();

      // 列表展示参数数量与依赖名称
      const row = page.locator('tr', { has: page.getByText(name, { exact: true }) });
      await expect(row.getByRole('cell', { name: '4', exact: true })).toBeVisible();
      await expect(row.getByText(depA.name, { exact: true })).toBeVisible();
      await expect(row.getByText(depB.name, { exact: true })).toBeVisible();

      // 编辑回显：四种类型与默认值、依赖勾选
      await page.getByRole('button', { name: `编辑 ${name}` }).click();
      const edit = page.getByRole('dialog');
      await expect(edit.locator('#param-key-0')).toHaveValue('mode');
      await expect(edit.locator('#param-key-1')).toHaveValue('features');
      await expect(edit.locator('#param-key-2')).toHaveValue('version');
      await expect(edit.locator('#param-key-3')).toHaveValue('verbose');
      await expect(edit.locator('#param-type-0')).toHaveValue('SELECT');
      await expect(edit.locator('#param-type-1')).toHaveValue('MULTI_SELECT');
      await expect(edit.locator('#param-type-2')).toHaveValue('TEXT');
      await expect(edit.locator('#param-type-3')).toHaveValue('BOOLEAN');
      await expect(edit.locator('#param-default-0')).toHaveValue('fast');
      await expect(edit.locator('#param-default-2')).toHaveValue('22');
      await expect(edit.getByRole('checkbox', { name: depA.name })).toBeChecked();
      await expect(edit.getByRole('checkbox', { name: depB.name })).toBeChecked();

      await edit.getByRole('button', { name: '取消' }).click();
      await expect(edit).not.toBeVisible();
    } finally {
      await cleanupWorkloads(page, token);
    }
  });

  test('T-E12: blocks saving when a parameter is invalid (illegal value prompt)', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupWorkloads(page, token);

    const name = `${WL_PREFIX}invalid-${Date.now().toString(36)}`;

    await adminLoginViaUI(page);
    await page.getByRole('link', { name: /工作负载/ }).click();
    await page.getByRole('button', { name: '新建工作负载' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#workload-name').fill(name);
    await dialog.locator('#workload-init-script').fill('echo');

    await dialog.getByRole('button', { name: '添加参数' }).click();
    // 非法 key（以数字开头）→ 提示并禁用保存
    await dialog.locator('#param-key-0').fill('1bad');
    await dialog.locator('#param-label-0').fill('标签');
    await expect(
      dialog.getByText('参数标识需以小写字母开头，仅含小写字母/数字/下划线，长度 1~32'),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: '保存' })).toBeDisabled();

    // 修正 key，但下拉类型无可选项 → 仍拦截
    await dialog.locator('#param-key-0').fill('mode');
    await dialog.locator('#param-type-0').selectOption({ label: '下拉单选' });
    await expect(dialog.getByText('下拉类型至少需要一个可选项')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '保存' })).toBeDisabled();

    await dialog.getByRole('button', { name: '取消' }).click();
  });

  test('T-E13: blocks a dependency cycle with a prompt', async ({ page }) => {
    const token = await adminLoginApi(page);
    await cleanupWorkloads(page, token);

    const suffix = Date.now().toString(36);
    const a = await createWorkload(page, token, { name: `${WL_PREFIX}cyc-a-${suffix}`, initScript: 'echo a' });
    const b = await createWorkload(page, token, {
      name: `${WL_PREFIX}cyc-b-${suffix}`,
      initScript: 'echo b',
      dependsOnWorkloadIds: [a.id],
    });

    try {
      await adminLoginViaUI(page);
      await page.getByRole('link', { name: /工作负载/ }).click();

      // 编辑 a 并勾选 b → a→b→a 成环
      await page.getByRole('button', { name: `编辑 ${a.name}` }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('checkbox', { name: b.name }).click();
      await expect(dialog.getByText(/检测到依赖环/)).toBeVisible();
      await expect(dialog.getByRole('button', { name: '保存' })).toBeDisabled();

      await dialog.getByRole('button', { name: '取消' }).click();
    } finally {
      await cleanupWorkloads(page, token);
    }
  });

  test('T-E16: lists the four preset workloads with the preset badge', async ({ page }) => {
    const token = await adminLoginApi(page);
    await adminLoginViaUI(page);
    await page.getByRole('link', { name: /工作负载/ }).click();
    await expect(page).toHaveURL(/\/cloud-workloads/);
    await expect(page.getByRole('heading', { name: '工作负载' })).toBeVisible();

    // 迁移已执行：四个预制项均出现
    for (const name of ['Docker', 'Node.js', '.NET', 'Aspire']) {
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    }
    // 「预制」徽章恰好 4 个
    await expect(page.getByText('预制', { exact: true })).toHaveCount(4);

    // Aspire 行展示依赖 Docker / .NET
    const aspireRow = page.locator('tr', { has: page.getByText('Aspire', { exact: true }) });
    await expect(aspireRow.getByText('Docker', { exact: true })).toBeVisible();
    await expect(aspireRow.getByText('.NET', { exact: true })).toBeVisible();

    // Node.js 展示 2 个参数
    const nodeRow = page.locator('tr', { has: page.getByText('Node.js', { exact: true }) });
    await expect(nodeRow.getByRole('cell', { name: '2', exact: true })).toBeVisible();

    // 通过 API 校验预制标记（与 UI 展示一致）
    const presets = (await listWorkloads(page, token)).filter((w) => w.isPreset);
    expect(presets.map((w) => w.name).sort()).toEqual(['.NET', 'Aspire', 'Docker', 'Node.js']);
  });
});
