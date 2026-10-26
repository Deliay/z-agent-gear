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
