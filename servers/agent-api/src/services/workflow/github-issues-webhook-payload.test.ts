import { describe, it, expect } from 'vitest';
import { parseGithubIssuesEvent } from './github-issues-webhook-payload.js';
import { GithubWebhookPayloadError } from './github-webhook-payload.js';

const validIssue = {
  id: 123456,
  number: 42,
  title: '接入 Issues 联动',
  body: '需求正文',
  html_url: 'https://github.com/Deliay/z-agent-gear/issues/42',
  user: { login: 'octocat' },
  labels: [{ name: 'start-开发' }, { name: 'bug' }],
};

function parse(overrides: Record<string, unknown> = {}) {
  return parseGithubIssuesEvent(
    JSON.stringify({
      action: 'labeled',
      issue: validIssue,
      repository: { full_name: 'Deliay/z-agent-gear' },
      ...overrides,
    }),
  );
}

describe('parseGithubIssuesEvent', () => {
  it('归一化完整事件', () => {
    expect(parse()).toEqual({
      action: 'labeled',
      repoFullName: 'Deliay/z-agent-gear',
      issueId: '123456',
      issueNumber: 42,
      title: '接入 Issues 联动',
      body: '需求正文',
      issueUrl: 'https://github.com/Deliay/z-agent-gear/issues/42',
      author: 'octocat',
      labels: ['start-开发', 'bug'],
    });
  });
});

describe('parseGithubIssuesEvent 边界', () => {
  it.each(['opened', 'labeled', 'edited', 'reopened'])('受理 action %s', (action) => {
    expect(parse({ action })?.action).toBe(action);
  });

  it.each(['closed', 'assigned', 'deleted'])('不受理 action %s 返回 null', (action) => {
    expect(parse({ action })).toBeNull();
  });

  it('body / user 为空时省略', () => {
    const result = parse({ issue: { ...validIssue, body: null, user: null } });
    expect(result?.body).toBeUndefined();
    expect(result?.author).toBeUndefined();
    expect(result?.labels).toEqual(['start-开发', 'bug']);
  });

  it.each([
    ['action', { action: 42 }],
    ['issue', { issue: null }],
    ['issue.id', { issue: { ...validIssue, id: 0 } }],
    ['issue.number', { issue: { ...validIssue, number: 'x' } }],
    ['issue.title', { issue: { ...validIssue, title: '' } }],
    ['issue.html_url', { issue: { ...validIssue, html_url: '' } }],
    ['issue.labels', { issue: { ...validIssue, labels: undefined } }],
    ['repository.full_name', { repository: { full_name: 'not-a-full-name' } }],
  ])('必填字段缺失 detail=%s', (detail, overrides) => {
    try {
      parse(overrides);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GithubWebhookPayloadError);
      expect((err as GithubWebhookPayloadError).detail).toBe(detail);
    }
  });

  it('title 超过 256 / body 超过 64000 / 非法 JSON 报错', () => {
    expect(() => parse({ issue: { ...validIssue, title: 'x'.repeat(257) } })).toThrow(
      GithubWebhookPayloadError,
    );
    expect(() => parse({ issue: { ...validIssue, body: 'x'.repeat(64_001) } })).toThrow(
      GithubWebhookPayloadError,
    );
    expect(() => parseGithubIssuesEvent('{')).toThrow(GithubWebhookPayloadError);
  });
});
