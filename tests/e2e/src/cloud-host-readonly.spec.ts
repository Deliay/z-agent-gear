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
    // 历史消息文本需在页面上可唯一定位（断言「历史消息保留」而非仅渲染空会话）。
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
      sessionId = session.insertedId;
      // 会话历史经 SSE history 下发（sessionService.getMessages），故直写 acpmessages；
      // content 为纯文本时 MessageItem 原样渲染，便于断言消息保留。
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
      // 只读：整个页面不应存在任何可输入的 textbox（禁用态输入框同样不应出现）
      await expect(page.getByRole('textbox')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /继续/ })).toHaveCount(0);
      // 历史消息仍可回看
      await expect(page.getByText(historyText)).toBeVisible({ timeout: 15000 });
    } finally {
      // 兜底清理放在 finally：断言失败也不会遗留 fixture（Controller/会话/消息仅软删除路径保留）
      if (sessionId) await db.collection('acpmessages').deleteMany({ sessionId });
      await db.collection('sessions').deleteMany({ controllerId });
      await db.collection('cloudhosts').deleteOne({ _id: hostId });
      await db.collection('controllerworkspaces').deleteOne({ _id: workspaceId });
      await db.collection('controllers').deleteOne({ _id: controllerId });
    }
  });
});
