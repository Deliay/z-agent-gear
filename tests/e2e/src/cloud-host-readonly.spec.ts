import { test, expect, type Page } from '@playwright/test';
import mongoose from 'mongoose';
import { loginViaUI, registerUser } from './helpers';

// fixture 驱动：K8S_ENABLED=false 下无法真实产生 RUNNING→STOPPED 的会话，
// 直接写 Mongo 构造「终态/软删除云电脑 + ended 会话」，断言前端只读渲染。
const HAS_MONGO = Boolean(process.env.MONGODB_URI);

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  return mongoose.connection.db ?? null;
}

async function runReadonlyScenario(page: Page, options: { deletedAt: Date | null }): Promise<void> {
  const { username } = await registerUser(page);
  const db = (await mongoDb())!;
  const userDoc = await db.collection('users').findOne({ username });
  expect(userDoc?._id).toBeTruthy();
  const userId = userDoc!._id;

  const now = new Date();
  const controllerId = new mongoose.Types.ObjectId();
  const hostId = new mongoose.Types.ObjectId();
  const workspaceId = new mongoose.Types.ObjectId();
  const historyText = `只读历史消息-${new mongoose.Types.ObjectId().toString()}`;
  let sessionId: mongoose.Types.ObjectId | null = null;

  try {
    await db.collection('controllers').insertOne({
      _id: controllerId,
      userId,
      name: `readonly-${controllerId.toString()}`,
      hostname: `readonly-${controllerId.toString()}`,
      type: 'cloud',
      status: 'offline',
      keyId: new mongoose.Types.ObjectId(),
      version: '2.5.0',
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('controllerworkspaces').insertOne({
      _id: workspaceId,
      userId,
      controllerId,
      name: 'workspace',
      path: '/root/workspace',
      isEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('cloudhosts').insertOne({
      _id: hostId,
      userId,
      name: `readonly-${hostId.toString()}`,
      harnessTypes: ['OPENCODE'],
      status: 'STOPPED',
      controllerId,
      keyId: new mongoose.Types.ObjectId(),
      workspaceId,
      containerId: null,
      defaultSessionId: null,
      startedAt: now,
      readyAt: now,
      stoppedAt: now,
      failureReason: null,
      deletedAt: options.deletedAt,
      createdAt: now,
      updatedAt: now,
    });
    const session = await db.collection('sessions').insertOne({
      userId,
      controllerId,
      controllerName: `readonly-${controllerId.toString()}`,
      acpServerType: 'opencode',
      status: 'ended',
      title: '历史会话',
      cwd: '/root/workspace',
      endedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    sessionId = session.insertedId;
    await db.collection('acpmessages').insertOne({
      sessionId,
      direction: 'input',
      type: 'text',
      content: historyText,
      createdAt: now,
      updatedAt: now,
    });

    await loginViaUI(page, username);
    await page.goto(`/sessions/${sessionId.toString()}`);

    await expect(page.getByTestId('cloud-host-readonly-notice')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('cloud-host-readonly-notice')).toContainText('云电脑已销毁');
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /继续/ })).toHaveCount(0);
    await expect(page.getByText(historyText)).toBeVisible({ timeout: 15000 });
  } finally {
    if (sessionId) await db.collection('acpmessages').deleteMany({ sessionId });
    await db.collection('sessions').deleteMany({ controllerId });
    await db.collection('cloudhosts').deleteOne({ _id: hostId });
    await db.collection('controllerworkspaces').deleteOne({ _id: workspaceId });
    await db.collection('controllers').deleteOne({ _id: controllerId });
  }
}

test.describe('Cloud Host read-only session', () => {
  test.skip(!HAS_MONGO, '需要 MONGODB_URI 写入只读 fixture');

  test('T-AW10: stopped cloud host session hides input/send/continue', async ({ page }) => {
    await runReadonlyScenario(page, { deletedAt: null });
  });

  test('R2-10: soft-deleted cloud host session hides input/send/continue', async ({ page }) => {
    await runReadonlyScenario(page, { deletedAt: new Date() });
  });
});
