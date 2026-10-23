import { test, expect, type Page } from '@playwright/test';
import mongoose from 'mongoose';
import { ADMIN_WEB_URL, adminGqlRequest, adminLoginApi, adminLoginViaUI } from './helpers.js';
import { InMemoryK8sClient } from '../../../servers/cloud-controller/src/services/k8s-client';
import { K8sJobManager } from '../../../servers/cloud-controller/src/services/k8s-job-manager';

// 计划用例覆盖说明（Phase 8）：
// - T-E1 启动 idle 容器、T-E3 强制销毁：本文件 UI 覆盖。
// - T-E2 未带/伪 token 被拒：见 tests/api/src/cloud-controller/worker-handshake.test.ts。
// - T-E5 非管理员/未登录访问拒绝：本文件覆盖（ProtectedRoute 重定向）。
// - T-E4 异常退出/超时保留 exitReason 且可强制销毁、T-E6 列表与 Job 实际状态对账：
//   K8S_ENABLED=false 下无真实 Job 可对账，改由 cloud-controller 单测锚定
//   （status-sync.test.ts T-Y1/T-Y3/T-Y5 + reconcile；container-service.test.ts T-S4/T-S4b）。
//   真实集群链路按计划列为部署侧手工验收。
// - T-E14 启动对话框参数表单默认值/隐式依赖提示/初始化顺序预览：本文件 UI 覆盖。
// - T-E15 日志对话框参数快照：直写 cloudworkloadlogs 构造（需要 MONGODB_URI）。

interface ContainerNode {
  id: string;
  name: string;
  status: string;
  purpose: string;
  workloads?: Array<{ id: string; name: string }>;
  currentWorkloadName?: string | null;
}

const LIST = `query { adminCloudContainers { id name status purpose workloads { id name } currentWorkloadName } }`;

async function listContainers(page: Page, token: string): Promise<ContainerNode[]> {
  const res = await adminGqlRequest(page, LIST, undefined, token);
  const body = await res.json();
  return (body.data?.adminCloudContainers ?? []) as ContainerNode[];
}

async function destroyViaApi(page: Page, token: string, id: string) {
  await adminGqlRequest(page, `mutation($id: ID!) { adminDestroyCloudContainer(id: $id) }`, { id }, token);
}

interface CreatedWorkload {
  id: string;
  name: string;
}

/** 经 API 创建工作负载（含可选参数/依赖），用于启动对话框用例的前置数据。 */
async function createWorkload(
  page: Page,
  token: string,
  input: {
    name: string;
    initScript?: string;
    postScript?: string;
    paramSchema?: Array<{
      key: string;
      label: string;
      type: string;
      options?: string[];
      defaultValue: unknown;
    }>;
    dependsOnWorkloadIds?: string[];
  },
): Promise<CreatedWorkload> {
  const res = await adminGqlRequest(
    page,
    `mutation($input: CreateCloudWorkloadInput!) { adminCreateCloudWorkload(input: $input) { id name } }`,
    { input },
    token,
  );
  const body = await res.json();
  expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
  return body.data.adminCreateCloudWorkload as CreatedWorkload;
}

async function deleteWorkload(page: Page, token: string, id: string): Promise<void> {
  await adminGqlRequest(page, `mutation($id: ID!) { adminDeleteCloudWorkload(id: $id) }`, { id }, token).catch(
    () => {},
  );
}

async function startContainer(page: Page, token: string): Promise<ContainerNode> {
  const res = await adminGqlRequest(
    page,
    `mutation($purpose: CloudContainerPurpose!) {
      adminStartCloudContainer(purpose: $purpose) { id name status workloads { id name } currentWorkloadName }
    }`,
    { purpose: 'IDLE' },
    token,
  );
  const body = await res.json();
  expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
  return body.data.adminStartCloudContainer as ContainerNode;
}

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  return mongoose.connection.db ?? null;
}

test.describe('Admin Cloud Container E2E', () => {
  test('should show the cloud container page and start dialog (idle only)', async ({ page }) => {
    await adminLoginApi(page);
    await adminLoginViaUI(page);

    await page.getByRole('link', { name: /云端容器/ }).click();
    await expect(page).toHaveURL(/\/cloud-containers/);
    await expect(page.getByRole('heading', { name: '云端容器' })).toBeVisible();
    await expect(page.getByRole('button', { name: '启动', exact: true })).toBeVisible();

    // 启动对话框：本期仅 idle（T-E1/PRD 3.4）+ 工作负载多选入口
    await page.getByRole('button', { name: '启动', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('启动容器')).toBeVisible();
    await expect(dialog.getByText(/本期仅支持 idle/)).toBeVisible();
    await expect(dialog.getByText('工作负载', { exact: true })).toBeVisible();
    // 多选提示含契约上限（裁决 12）
    await expect(dialog.getByText(/可多选，按勾选顺序依次执行/)).toBeVisible();
    await expect(dialog.getByText(/最多 10 个/)).toBeVisible();
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('should start an idle container and force-destroy it (T-E1/T-E3)', async ({ page }) => {
    const token = await adminLoginApi(page);
    const before = await listContainers(page, token);
    const beforeIds = new Set(before.map((c) => c.id));

    await adminLoginViaUI(page);
    await page.getByRole('link', { name: /云端容器/ }).click();

    await page.getByRole('button', { name: '启动', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '确认启动' }).click();
    await expect(dialog).not.toBeVisible();

    // 通过 API 找到新建的容器（zag-worker-*）
    let created: ContainerNode | undefined;
    for (let i = 0; i < 20 && !created; i += 1) {
      const now = await listContainers(page, token);
      created = now.find((c) => !beforeIds.has(c.id));
      if (!created) await page.waitForTimeout(500);
    }
    expect(created, 'newly started container should be listed').toBeTruthy();
    expect(created!.name.startsWith('zag-worker-')).toBe(true);
    expect(['CREATING', 'CONNECTING', 'ONLINE']).toContain(created!.status);

    // UI 中可见该容器行
    const row = page.locator('tr', { hasText: created!.name }).first();
    await expect(row).toBeVisible();

    // 强制销毁二次确认（T-E3）
    await row.getByRole('button', { name: /强制销毁/ }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('heading', { name: '强制销毁容器' })).toBeVisible();
    await confirm.getByRole('button', { name: '强制销毁' }).click();

    // 轮询 API 直到状态为 EXITED
    let status = '';
    for (let i = 0; i < 20; i += 1) {
      const now = await listContainers(page, token);
      status = now.find((c) => c.id === created!.id)?.status ?? '';
      if (status === 'EXITED') break;
      await page.waitForTimeout(500);
    }
    expect(status).toBe('EXITED');

    // 兜底清理
    await destroyViaApi(page, token, created!.id);
  });

  test('T-E: shows the workload column and opens the logs dialog with an empty state', async ({ page }) => {
    const token = await adminLoginApi(page);
    const before = await listContainers(page, token);
    const beforeIds = new Set(before.map((c) => c.id));

    await adminLoginViaUI(page);
    await page.getByRole('link', { name: /云端容器/ }).click();
    await expect(page.getByRole('heading', { name: '云端容器' })).toBeVisible();

    // 启动一个不挂载工作负载的容器
    await page.getByRole('button', { name: '启动', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: '确认启动' }).click();
    await expect(dialog).not.toBeVisible();

    let created: ContainerNode | undefined;
    for (let i = 0; i < 20 && !created; i += 1) {
      const now = await listContainers(page, token);
      created = now.find((c) => !beforeIds.has(c.id));
      if (!created) await page.waitForTimeout(500);
    }
    expect(created, 'newly started container should be listed').toBeTruthy();
    expect(created!.workloads ?? []).toEqual([]);

    const row = page.locator('tr', { hasText: created!.name }).first();
    await expect(row).toBeVisible();
    // 「工作负载」列存在且无挂载时展示占位符（按列定位，避免命中名称中的连字符造成恒真断言）
    await expect(page.getByRole('columnheader', { name: '工作负载' })).toBeVisible();
    await expect(row.locator('td').nth(4)).toHaveText('-');

    // 日志入口可打开（无记录空态）
    await row.getByRole('button', { name: `工作负载日志 ${created!.name}` }).click();
    const logsDialog = page.getByRole('dialog');
    await expect(logsDialog.getByRole('heading', { name: '工作负载执行日志' })).toBeVisible();
    await expect(logsDialog.getByText('暂无执行记录')).toBeVisible();
    await logsDialog.getByRole('button', { name: 'Close' }).click();
    await expect(logsDialog).not.toBeVisible();

    // 兜底清理
    await destroyViaApi(page, token, created!.id);
  });

  test('T-E5: unauthenticated access to /cloud-containers is redirected to login', async ({ page }) => {
    await page.goto(`${ADMIN_WEB_URL}/cloud-containers`);
    await expect(page).toHaveURL(/\/login/);
  });

  test('T-E14: start dialog shows param defaults, implicit dependency hint and init order preview', async ({ page }) => {
    const token = await adminLoginApi(page);
    const suffix = Date.now().toString(36);
    const dep = await createWorkload(page, token, {
      name: `e2e-wlc-dep-${suffix}`,
      initScript: 'echo dep',
      paramSchema: [{ key: 'version', label: '版本', type: 'TEXT', options: [], defaultValue: '22' }],
    });
    const parent = await createWorkload(page, token, {
      name: `e2e-wlc-parent-${suffix}`,
      initScript: 'echo parent',
      paramSchema: [
        { key: 'mode', label: '模式', type: 'SELECT', options: ['fast', 'slow'], defaultValue: 'fast' },
      ],
      dependsOnWorkloadIds: [dep.id],
    });

    let containerId: string | null = null;
    try {
      await adminLoginViaUI(page);
      await page.getByRole('link', { name: /云端容器/ }).click();
      await expect(page.getByRole('heading', { name: '云端容器' })).toBeVisible();

      await page.getByRole('button', { name: '启动', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      // 选中依赖方 → 展开参数表单
      await dialog.getByRole('checkbox', { name: parent.name }).click();

      // 参数表单默认值预填（SELECT 默认 fast）
      await expect(dialog.locator(`#param-${parent.id}-mode`)).toHaveValue('fast');

      // 隐式依赖提示（未显式勾选 dep）
      await expect(dialog.getByText(new RegExp(`将自动初始化 ${dep.name}`))).toBeVisible();

      // 初始化顺序预览：dep（隐式）→ parent
      await expect(dialog.getByText('初始化顺序预览')).toBeVisible();
      const previewItems = dialog.locator('ol li');
      await expect(previewItems.first()).toContainText(dep.name);
      await expect(previewItems.nth(1)).toContainText(parent.name);
      await expect(dialog.getByText('隐式', { exact: true })).toBeVisible();

      await dialog.getByRole('button', { name: '确认启动' }).click();
      await expect(dialog).not.toBeVisible();

      // 轮询找到容器并核对挂载顺序 = 服务端展开的依赖顺序 dep → parent
      let created: ContainerNode | undefined;
      for (let i = 0; i < 20 && !created; i += 1) {
        const now = await listContainers(page, token);
        created = now.find((c) => c.workloads?.some((w) => w.id === parent.id));
        if (!created) await page.waitForTimeout(500);
      }
      expect(created, 'newly started container should mount parent + implicit dependency').toBeTruthy();
      containerId = created!.id;
      expect(created!.workloads?.map((w) => w.id)).toEqual([dep.id, parent.id]);

      // 容器行展示挂载名称
      const row = page.locator('tr', { hasText: created!.name }).first();
      await expect(row.getByText(dep.name)).toBeVisible();
      await expect(row.getByText(parent.name)).toBeVisible();
    } finally {
      if (containerId) await destroyViaApi(page, token, containerId);
      await deleteWorkload(page, token, dep.id);
      await deleteWorkload(page, token, parent.id);
    }
  });

  test('T-E15: logs dialog shows the parameter snapshot (direct Mongo)', async ({ page }) => {
    test.skip(!process.env.MONGODB_URI, 'MONGODB_URI 未提供，跳过直写 cloudworkloadlogs');

    const token = await adminLoginApi(page);
    const container = await startContainer(page, token);

    const db = await mongoDb();
    expect(db).not.toBeNull();
    const containerId = new mongoose.Types.ObjectId(container.id);
    const workloadId = new mongoose.Types.ObjectId();
    const now = new Date();
    await db!.collection('cloudworkloadlogs').insertOne({
      containerId,
      workloadId,
      workloadName: 'param-job',
      phase: 'init',
      status: 'success',
      script: 'echo params',
      params: { version: '20', package_manager: ['pnpm'] },
      exitCode: 0,
      log: '',
      startedAt: now,
      finishedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    try {
      await adminLoginViaUI(page);
      await page.getByRole('link', { name: /云端容器/ }).click();
      const row = page.locator('tr', { hasText: container.name }).first();
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: `工作负载日志 ${container.name}` }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText('参数快照')).toBeVisible();
      // formatParams：`version: 20` / `package_manager: ["pnpm"]`
      await expect(dialog.getByText(/version: 20/)).toBeVisible();
      await expect(dialog.getByText(/package_manager: \["pnpm"\]/)).toBeVisible();
    } finally {
      await db!.collection('cloudworkloadlogs').deleteMany({ containerId });
      await destroyViaApi(page, token, container.id);
    }
  });

  test('T-E17: the 必须 switch is shown only for selected workloads with an initScript', async ({ page }) => {
    const token = await adminLoginApi(page);
    const suffix = Date.now().toString(36);
    const withInit = await createWorkload(page, token, {
      name: `e2e-req-init-${suffix}`,
      initScript: 'echo init',
    });
    // 仅 postScript：无可标记的初始化脚本
    const postOnly = await createWorkload(page, token, {
      name: `e2e-req-post-${suffix}`,
      postScript: 'echo cleanup',
    });

    let containerId: string | null = null;
    try {
      await adminLoginViaUI(page);
      await page.getByRole('link', { name: /云端容器/ }).click();
      await page.getByRole('button', { name: '启动', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(/标记为必须的工作负载初始化失败将导致容器被强制注销/)).toBeVisible();

      // 未勾选：无开关
      await expect(dialog.getByRole('checkbox', { name: `${withInit.name} 必须`, exact: true })).toHaveCount(0);
      await dialog.getByRole('checkbox', { name: postOnly.name, exact: true }).click();
      // 仅 postScript：不展示开关
      await expect(dialog.getByRole('checkbox', { name: `${postOnly.name} 必须`, exact: true })).toHaveCount(0);

      // 必须开关的 aria-label 为 `${name} 必须`，会与工作负载多选项 `${name}` 子串匹配；必须 exact。
      await dialog.getByRole('checkbox', { name: withInit.name, exact: true }).click();
      const requiredSwitch = dialog.getByRole('checkbox', { name: `${withInit.name} 必须`, exact: true });
      await expect(requiredSwitch).toBeVisible();
      await expect(requiredSwitch).not.toBeChecked();
      await requiredSwitch.click();
      await expect(requiredSwitch).toBeChecked();

      // 取消勾选 → 开关消失；重新勾选 → 回到默认（非必须）
      await dialog.getByRole('checkbox', { name: withInit.name, exact: true }).click();
      await expect(dialog.getByRole('checkbox', { name: `${withInit.name} 必须`, exact: true })).toHaveCount(0);
      await dialog.getByRole('checkbox', { name: withInit.name, exact: true }).click();
      await expect(dialog.getByRole('checkbox', { name: `${withInit.name} 必须`, exact: true })).not.toBeChecked();

      // 提交并核对落库 required=true
      await requiredSwitch.click();
      await dialog.getByRole('button', { name: '确认启动' }).click();
      await expect(dialog).not.toBeVisible();

      let created: ContainerNode | undefined;
      for (let i = 0; i < 20 && !created; i += 1) {
        const now = await listContainers(page, token);
        created = now.find((c) => c.workloads?.some((w) => w.id === withInit.id));
        if (!created) await page.waitForTimeout(500);
      }
      expect(created, 'container should mount the required workload').toBeTruthy();
      containerId = created!.id;

      const db = await mongoDb();
      if (db) {
        const doc = await db
          .collection('cloudcontainers')
          .findOne({ _id: new mongoose.Types.ObjectId(containerId) });
        const plan = (doc?.workloadPlan ?? []) as Array<{ workloadId: unknown; required?: unknown }>;
        const entry = plan.find((item) => String(item.workloadId) === withInit.id);
        expect(entry?.required).toBe(true);
      }
    } finally {
      if (containerId) await destroyViaApi(page, token, containerId);
      await deleteWorkload(page, token, withInit.id);
      await deleteWorkload(page, token, postOnly.id);
    }
  });

  test('T-E18: the order preview marks required items (implicit deps unaffected)', async ({ page }) => {
    const token = await adminLoginApi(page);
    const suffix = Date.now().toString(36);
    const dep = await createWorkload(page, token, {
      name: `e2e-req-dep-${suffix}`,
      initScript: 'echo dep',
    });
    const parent = await createWorkload(page, token, {
      name: `e2e-req-parent-${suffix}`,
      initScript: 'echo parent',
      dependsOnWorkloadIds: [dep.id],
    });

    try {
      await adminLoginViaUI(page);
      await page.getByRole('link', { name: /云端容器/ }).click();
      await page.getByRole('button', { name: '启动', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      await dialog.getByRole('checkbox', { name: parent.name }).click();
      await dialog.getByRole('checkbox', { name: `${parent.name} 必须` }).click();

      const previewItems = dialog.locator('ol li');
      await expect(previewItems.first()).toContainText(dep.name);
      await expect(previewItems.first()).toContainText('隐式');
      await expect(previewItems.nth(1)).toContainText(parent.name);
      await expect(previewItems.nth(1)).toContainText('必须');

      await dialog.getByRole('button', { name: '取消' }).click();
    } finally {
      await deleteWorkload(page, token, dep.id);
      await deleteWorkload(page, token, parent.id);
    }
  });

  test('T-E19: logs dialog marks required records and leaves history unmarked (direct Mongo)', async ({ page }) => {
    test.skip(!process.env.MONGODB_URI, 'MONGODB_URI 未提供，跳过直写 cloudworkloadlogs');

    const token = await adminLoginApi(page);
    const container = await startContainer(page, token);

    const db = await mongoDb();
    expect(db).not.toBeNull();
    const containerId = new mongoose.Types.ObjectId(container.id);
    const now = new Date();
    await db!.collection('cloudworkloadlogs').insertMany([
      {
        containerId,
        workloadId: new mongoose.Types.ObjectId(),
        workloadName: 'must-setup',
        phase: 'init',
        status: 'failed',
        script: 'exit 1',
        params: {},
        required: true,
        exitCode: 1,
        log: 'boom\n',
        startedAt: now,
        finishedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        containerId,
        workloadId: new mongoose.Types.ObjectId(),
        workloadName: 'legacy-setup',
        phase: 'init',
        status: 'success',
        script: 'echo ok',
        params: {},
        exitCode: 0,
        log: '',
        startedAt: now,
        finishedAt: now,
        createdAt: new Date(now.getTime() + 1),
        updatedAt: now,
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
      // 列表行内徽标与详情面板各渲染一次「必须」；断言限定详情面板，避免 strict-mode 双命中。
      const detail = dialog.getByTestId('workload-log-detail');
      // 必须项记录在详情面板出现「必须」标识；历史记录不误标（默认选中首条 = must-setup）
      await expect(detail.getByText('必须', { exact: true })).toBeVisible();
      // 切到历史记录：详情面板无「必须」标识
      await dialog.getByRole('button', { name: /查看 legacy-setup/ }).click();
      await expect(detail.getByText('必须', { exact: true })).toHaveCount(0);
    } finally {
      await db!.collection('cloudworkloadlogs').deleteMany({ containerId });
      await destroyViaApi(page, token, container.id);
    }
  });

  // E2E-4：云电脑 Job 模板资源约束。K8S_ENABLED=false 时无真实 Job 可读，
  // 复用 cloud-controller 的 manifest 构造器断言（与运行时同一份代码）。
  test('E2E-4: 云电脑 Job limits 含 ephemeral-storage 10Gi（不设置 requests）', async () => {
    const manager = new K8sJobManager(new InMemoryK8sClient(), {
      namespace: 'zag-cloud',
      image: 'worker:e2e',
      runtimeClassName: 'sysbox-runc',
      publicWsEndpoint: 'cloud.example.com:4003',
    });
    const manifest = manager.buildManifest({
      jobName: 'zag-worker-e2e',
      containerId: 'container-e2e',
      token: 'container-e2e.secret',
    });
    const resources = manifest.spec.template.spec.containers[0]!.resources;
    // 与 main 口径一致：不设置 requests，仅声明 limits 硬上限
    expect(resources.requests).toBeUndefined();
    expect(resources.limits['ephemeral-storage']).toBe('10Gi');
  });

  test('T-E20: container list shows the must-failure exit reason (direct Mongo)', async ({ page }) => {
    test.skip(!process.env.MONGODB_URI, 'MONGODB_URI 未提供，跳过直写 cloudcontainers');

    const token = await adminLoginApi(page);
    const container = await startContainer(page, token);

    const db = await mongoDb();
    expect(db).not.toBeNull();
    const reason = `必须工作负载「must-a」初始化失败`;
    await db!
      .collection('cloudcontainers')
      .updateOne(
        { _id: new mongoose.Types.ObjectId(container.id) },
        { $set: { status: 'exited', exitedAt: new Date(), exitReason: reason } },
      );

    try {
      await adminLoginViaUI(page);
      await page.getByRole('link', { name: /云端容器/ }).click();
      const row = page.locator('tr', { hasText: container.name }).first();
      await expect(row).toBeVisible();
      await expect(row.getByText(/必须工作负载「must-a」初始化失败/)).toBeVisible();
    } finally {
      await destroyViaApi(page, token, container.id);
    }
  });
});
