import { test, expect } from '@playwright/test';
import mongoose from 'mongoose';
import { loginViaUI, registerUser } from './helpers';

// fixture 驱动：K8S_ENABLED=false 下无法真实产生 RUNNING→STOPPED 的会话，
// 直接写 Mongo 构造「已销毁云电脑 + ended 会话」，断言前端只读渲染。
const HAS_MONGO = Boolean(process.env.MONGODB_URI);

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  return mongoose.connection.db ?? null;
}

test.describe('Cloud Host read-only session', () => {
  test.skip(!HAS_MONGO, '需要 MONGODB_URI 写入只读 fixture');

  test('T-AW10: stopped cloud host session hides input/send/continue', async ({ page }) => {
    const { username } = await registerUser(page);
    // 从 Mongo 反查用户名对应的 userId
    const db = (await mongoDb())!;
    const userDoc = await db.collection('users').findOne({ username });
    expect(userDoc?._id).toBeTruthy();
    const userId = userDoc!._id;

    const now = new Date();
    const controllerId = new mongoose.Types.ObjectId();
    const hostId = new mongoose.Types.ObjectId();
    const workspaceId = new mongoose.Types.ObjectId();
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
      deletedAt: null,
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

    await loginViaUI(page, username);
    await page.goto(`/sessions/${session.insertedId.toString()}`);

    await expect(page.getByTestId('cloud-host-readonly-notice')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('cloud-host-readonly-notice')).toContainText('云电脑已销毁');
    await expect(page.getByPlaceholder(/Type your message/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /继续/ })).toHaveCount(0);

    // 清理 fixture（Controller/会话/消息保留语义仅在软删除路径；测试数据直接清理）
    await db.collection('sessions').deleteOne({ _id: session.insertedId });
    await db.collection('cloudhosts').deleteOne({ _id: hostId });
    await db.collection('controllerworkspaces').deleteOne({ _id: workspaceId });
    await db.collection('controllers').deleteOne({ _id: controllerId });
  });
});
