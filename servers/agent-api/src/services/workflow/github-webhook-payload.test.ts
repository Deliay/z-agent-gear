import { describe, it, expect } from 'vitest';
import {
  parseGithubReviewEvent,
  GithubWebhookPayloadError,
} from './github-webhook-payload.js';

const validEvent = {
  action: 'submitted',
  review: {
    id: 987654321,
    state: 'approved',
    body: 'LGTM，注意补充测试',
    user: { login: 'z-agent-bot' },
    submitted_at: '2026-10-25T06:00:00Z',
  },
  repository: { full_name: 'Deliay/z-agent-gear' },
  pull_request: {
    number: 264,
    html_url: 'https://github.com/Deliay/z-agent-gear/pull/264',
  },
};

function parse(overrides: Record<string, unknown> = {}) {
  return parseGithubReviewEvent(JSON.stringify({ ...validEvent, ...overrides }));
}

describe('parseGithubReviewEvent', () => {
  it('归一化完整事件', () => {
    expect(parse()).toEqual({
      eventType: 'pull_request',
      eventId: 'gh:pull_request_review:987654321',
      occurredAt: '2026-10-25T06:00:00Z',
      payload: {
        pullRequestId: 'Deliay/z-agent-gear#264',
        reviewState: 'approved',
        action: 'reviewed',
        prUrl: 'https://github.com/Deliay/z-agent-gear/pull/264',
        comment: 'LGTM，注意补充测试',
        reviewer: 'z-agent-bot',
        submittedAt: '2026-10-25T06:00:00Z',
      },
    });
  });

  it('非 submitted action 返回 null', () => {
    expect(parse({ action: 'edited' })).toBeNull();
    expect(parse({ action: 'dismissed' })).toBeNull();
  });

  it('review.user / review.body 为 null 时省略对应字段', () => {
    const event = parse({
      review: { ...validEvent.review, user: null, body: null, submitted_at: undefined },
      pull_request: { number: 264 },
    });
    expect(event).toEqual({
      eventType: 'pull_request',
      eventId: 'gh:pull_request_review:987654321',
      payload: {
        pullRequestId: 'Deliay/z-agent-gear#264',
        reviewState: 'approved',
        action: 'reviewed',
      },
    });
  });

  it('reviewState 原样透传（含 commented 等非结论状态）', () => {
    expect(parse({ review: { ...validEvent.review, state: 'commented' } })?.payload.reviewState)
      .toBe('commented');
  });

  it.each([
    ['非 JSON', 'not-json{{{', 'json'],
    ['非对象', '"just a string"', 'body'],
    ['缺 action', { ...validEvent, action: undefined }, 'action'],
    ['缺 review', { ...validEvent, review: undefined }, 'review'],
    ['缺 review.id', { ...validEvent, review: { ...validEvent.review, id: undefined } }, 'review.id'],
    ['review.id 非正整数', { ...validEvent, review: { ...validEvent.review, id: -1 } }, 'review.id'],
    ['缺 review.state', { ...validEvent, review: { ...validEvent.review, state: '' } }, 'review.state'],
    ['缺 repository', { ...validEvent, repository: undefined }, 'repository'],
    ['full_name 非两段', { ...validEvent, repository: { full_name: 'noSlash' } }, 'repository.full_name'],
    ['full_name 含空段', { ...validEvent, repository: { full_name: 'a/' } }, 'repository.full_name'],
    ['full_name 为 ..', { ...validEvent, repository: { full_name: '../..' } }, 'repository.full_name'],
    ['缺 pull_request', { ...validEvent, pull_request: undefined }, 'pull_request'],
    ['缺 pull_request.number', { ...validEvent, pull_request: { html_url: 'x' } }, 'pull_request.number'],
    ['review.user 非对象', { ...validEvent, review: { ...validEvent.review, user: 'ghost' } }, 'review.user'],
    ['submitted_at 非法日期', { ...validEvent, review: { ...validEvent.review, submitted_at: 'not-a-date' } }, 'review.submitted_at'],
  ])('载荷非法：%s → detail=%s', (_label, input, detail) => {
    const raw = typeof input === 'string' ? input : JSON.stringify(input);
    let caught: unknown;
    try {
      parseGithubReviewEvent(raw);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GithubWebhookPayloadError);
    expect((caught as GithubWebhookPayloadError).detail).toBe(detail);
  });
});
