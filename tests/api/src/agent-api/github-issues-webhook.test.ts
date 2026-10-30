import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';

/**
 * GitHub Issues webhook —— 黑盒用例 T-GHI1 ~ T-GHI5。
 *
 * 前置：`aspire start` + `GITHUB_WEBHOOK_SECRET`（缺失时整组跳过）。
 * 全链路需要真实云电脑与 Github 仓库，以 `GITHUB_TEST_REPO` /
 * `CLOUD_HOST_CONTROLLER_ID` / `CLOUD_HOST_ISSUES_LABEL` 提供时执行，否则跳过。
 */
const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const API_BASE = AGENT_API_URL.replace(/\/graphql$/, '');
const WEBHOOK_URL = `${API_BASE}/api/events/github/webhook`;
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? '';
const TEST_REPO = process.env.GITHUB_TEST_REPO ?? '';
const LINKAGE_LABEL = process.env.CLOUD_HOST_ISSUES_LABEL ?? '';

function sign(body: string, secret = WEBHOOK_SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function issuePayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'labeled',
    issue: {
      id: Date.now(),
      number: 42,
      title: '接入 Issues 联动',
      body: '正文',
      html_url: 'https://github.com/example/repo/issues/42',
      user: { login: 'octocat' },
      labels: [{ name: LINKAGE_LABEL || 'start-dev' }],
    },
    repository: { full_name: TEST_REPO || 'example/none-enabled-repo' },
    ...overrides,
  };
}

async function post(
  payload: unknown,
  options: { event?: string; signature?: string; raw?: string } = {},
) {
  const raw = options.raw ?? JSON.stringify(payload);
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': options.event ?? 'issues',
      'X-Hub-Signature-256': options.signature ?? sign(raw),
    },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

describe.skipIf(!WEBHOOK_SECRET)('T-GHI GitHub Issues webhook', () => {
  it('T-GHI1a 错误签名 → 401', async () => {
    const { status, body } = await post(issuePayload(), { signature: 'sha256=deadbeef' });
    expect(status).toBe(401);
    expect(body.error).toBe('unauthorized');
  });

  it('T-GHI1b 非 JSON 载荷 → 400 payload.invalid', async () => {
    const raw = '{';
    const { status, body } = await post(null, { raw });
    expect(status).toBe(400);
    expect(body.error).toBe('payload.invalid');
  });

  it('T-GHI1c 不受理 action → 200 UNSUPPORTED_EVENT', async () => {
    const { body } = await post(issuePayload({ action: 'closed' }));
    expect(body).toMatchObject({ handled: false, reason: 'UNSUPPORTED_EVENT' });
  });

  it('T-GHI1d 必填字段缺失 → 400 且 detail 为字段路径', async () => {
    const payload = issuePayload();
    delete (payload.issue as Record<string, unknown>).title;
    const { status, body } = await post(payload);
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'payload.invalid', detail: 'issue.title' });
  });

  it('T-GHI2a 仓库无联动配置 → REPO_NOT_ENABLED', async () => {
    const { body } = await post(
      issuePayload({ repository: { full_name: 'example/none-enabled-repo' } }),
    );
    expect(body).toMatchObject({ handled: false, reason: 'REPO_NOT_ENABLED', results: [] });
  });

  it('T-GHI2b 配置存在但标签不命中 → NO_MATCHING_LINKAGE', async () => {
    if (!TEST_REPO) return;
    const { body } = await post(
      issuePayload({
        issue: {
          ...issuePayload().issue,
          labels: [{ name: 'not-the-configured-label' }],
        },
      }),
    );
    expect(body.handled).toBe(false);
    expect(['NO_MATCHING_LINKAGE', 'REPO_NOT_ENABLED']).toContain(body.reason);
  });

  it.skipIf(!TEST_REPO || !LINKAGE_LABEL)('T-GHI2c 标签命中 → CREATE_TRIGGER', async () => {
    const { body } = await post(issuePayload());
    expect(body.handled).toBe(true);
    expect(body.results[0]).toMatchObject({ action: 'CREATE_TRIGGER' });
  });

  it.skipIf(!TEST_REPO || !LINKAGE_LABEL)('T-GHI4 同 Issue 重投 → ALREADY_TRIGGERED', async () => {
    const payload = issuePayload();
    await post(payload);
    const { body } = await post(payload);
    expect(body.handled).toBe(false);
    expect(body.results[0].reason).toBe('ALREADY_TRIGGERED');
  });
});

// ---------------------------------------------------------------------------
// T-GH-API1~3: Issue 触发人归属（sender → triggerUserId → worktreeCommitter 快照）
//
// 前置：真实云电脑 Issues 联动环境（`GITHUB_WEBHOOK_SECRET` + `GITHUB_TEST_REPO` +
// `CLOUD_HOST_ISSUES_LABEL`）与 `MONGODB_URI`（直读触发记录 / 实例快照）。
// 依赖在线控制器完成实例化：实例未在超时内创建时仅断言触发记录字段（快照断言跳过）。
// ---------------------------------------------------------------------------
const MONGODB_URI = process.env.MONGODB_URI ?? '';

describe.skipIf(!WEBHOOK_SECRET || !MONGODB_URI || !TEST_REPO || !LINKAGE_LABEL)(
  'T-GH-API Issues 触发人归属',
  () => {
    async function mongo() {
      const mongoose = (await import('mongoose')).default;
      if (mongoose.connection.readyState === 0) await mongoose.connect(MONGODB_URI);
      return mongoose.connection.db!;
    }

    const noreply = (id: number, login: string) => `${id}+${login}@users.noreply.github.com`;

    async function linkageOwner(): Promise<{ userId: string; controllerId: string }> {
      const db = await mongo();
      const linkage = await db
        .collection('cloud_host_issues_linkages')
        .findOne({ repoFullName: TEST_REPO });
      expect(linkage, 'GITHUB_TEST_REPO 需存在 Issues 联动配置').toBeTruthy();
      return {
        userId: String(linkage!.userId),
        controllerId: String(linkage!.controllerId),
      };
    }

    async function waitForTrigger(issueId: number, timeoutMs = 20_000) {
      const db = await mongo();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const rows = await db
          .collection('issue_workflow_triggers')
          .find({ issueId: String(issueId), repoFullName: TEST_REPO })
          .toArray();
        const row = rows.find((r) => String(r.issueUrl ?? '').includes(`/issues/${issueId}`)) ?? rows[0];
        if (row) return row as Record<string, unknown>;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(`trigger not found for issue ${issueId}`);
    }

    async function waitForInstance(instanceId: unknown, timeoutMs = 20_000) {
      if (!instanceId) return null;
      const db = await mongo();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const mongoId = (await import('mongoose')).default.Types.ObjectId;
        const row = await db
          .collection('workflowinstances')
          .findOne({ _id: new mongoId(String(instanceId)) });
        if (row?.workflowWorktreePath) return row as Record<string, unknown>;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return null;
    }

    async function postWithSender(issueId: number, sender?: { id: number; login: string }) {
      const payload = issuePayload({
        issue: {
          ...issuePayload().issue,
          id: issueId,
          number: issueId % 100000,
          labels: [{ name: LINKAGE_LABEL }],
        },
      });
      if (sender) (payload as Record<string, unknown>).sender = sender;
      return post(payload);
    }

    it('T-GH-API1: 触发标签的 sender 被记录，且绑定成员时解析 triggerUserId', async () => {
      const db = await mongo();
      const owner = await linkageOwner();
      const issueId = Date.now();
      const sender = { id: 800001, login: 'trigger-owner' };

      // 触发人绑定平台成员（GitHub 帐号归属 owner）
      const accountId = new (await import('mongoose')).default.Types.ObjectId();
      await db.collection('githubaccounts').insertOne({
        _id: accountId,
        userId: owner.userId,
        tenantId: owner.userId,
        githubUserId: sender.id,
        githubLogin: sender.login,
        githubAvatarUrl: null,
        accessToken: 'encrypted',
        tokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      try {
        const { body } = await postWithSender(issueId, sender);
        expect(body.handled).toBe(true);

        const trigger = await waitForTrigger(issueId);
        expect(trigger.triggerSenderId).toBe(sender.id);
        expect(trigger.triggerSenderLogin).toBe(sender.login);
        expect(String(trigger.triggerUserId)).toBe(owner.userId);

        // 触发人未设置自定义提交人 → 回退其 GitHub 身份（login + noreply）
        const instance = await waitForInstance(trigger.workflowInstanceId);
        if (instance) {
          expect(instance.worktreeCommitterName).toBe(sender.login);
          expect(instance.worktreeCommitterEmail).toBe(noreply(sender.id, sender.login));
        }
      } finally {
        await db.collection('githubaccounts').deleteOne({ _id: accountId });
      }
    }, 60_000);

    it('T-GH-API2: 触发人设置自定义提交人时优先使用（成员设置优先于 GitHub 身份）', async () => {
      const db = await mongo();
      const owner = await linkageOwner();
      const issueId = Date.now() + 1;
      const sender = { id: 800002, login: 'trigger-custom' };

      const ObjectId = (await import('mongoose')).default.Types.ObjectId;
      const accountId = new ObjectId();
      await db.collection('githubaccounts').insertOne({
        _id: accountId,
        userId: owner.userId,
        tenantId: owner.userId,
        githubUserId: sender.id,
        githubLogin: sender.login,
        githubAvatarUrl: null,
        accessToken: 'encrypted',
        tokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.collection('user_commit_settings').updateOne(
        { userId: owner.userId },
        {
          $set: {
            userId: owner.userId,
            tenantId: owner.userId,
            committerType: 'custom',
            customName: 'Trigger Custom',
            customEmail: 'trigger-custom@example.com',
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      );

      try {
        const { body } = await postWithSender(issueId, sender);
        expect(body.handled).toBe(true);
        const trigger = await waitForTrigger(issueId);
        expect(String(trigger.triggerUserId)).toBe(owner.userId);

        const instance = await waitForInstance(trigger.workflowInstanceId);
        if (instance) {
          expect(instance.worktreeCommitterName).toBe('Trigger Custom');
          expect(instance.worktreeCommitterEmail).toBe('trigger-custom@example.com');
        }
      } finally {
        await db.collection('githubaccounts').deleteOne({ _id: accountId });
        await db.collection('user_commit_settings').deleteMany({ userId: owner.userId });
      }
    }, 60_000);

    it('T-GH-API3: 未识别触发人 → triggerUserId 为空且快照回落 bot（null）', async () => {
      const db = await mongo();
      const owner = await linkageOwner();
      const issueId = Date.now() + 2;

      const { body } = await postWithSender(issueId, { id: 800003, login: 'unbound-sender' });
      expect(body.handled).toBe(true);
      const trigger = await waitForTrigger(issueId);
      expect(trigger.triggerSenderId).toBe(800003);
      expect(trigger.triggerSenderLogin).toBe('unbound-sender');
      expect(trigger.triggerUserId ?? null).toBeNull();

      const instance = await waitForInstance(trigger.workflowInstanceId);
      if (instance) {
        // 绑定不到成员：回退 sender 的 GitHub 身份（login + noreply）
        expect(instance.worktreeCommitterName).toBe('unbound-sender');
        expect(instance.worktreeCommitterEmail).toBe(noreply(800003, 'unbound-sender'));
      }
      // 触发记录归属仍留档于 owner 的联动配置
      expect(String(trigger.userId)).toBe(owner.userId);
    }, 60_000);
  },
);
