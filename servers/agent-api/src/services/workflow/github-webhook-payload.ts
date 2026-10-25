import type { EventCallbackPayload } from './pr-event-payload.js';

/** GitHub 原生 webhook 载荷校验失败：detail 为字段路径（响应 400 payload.invalid） */
export class GithubWebhookPayloadError extends Error {
  constructor(public readonly detail: string) {
    super(`payload.invalid: ${detail}`);
    this.name = 'GithubWebhookPayloadError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, detail: string, maxLength?: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GithubWebhookPayloadError(detail);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new GithubWebhookPayloadError(detail);
  }
  return value;
}

function optionalString(value: unknown, detail: string, maxLength?: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new GithubWebhookPayloadError(detail);
  if (maxLength !== undefined && value.length > maxLength) {
    throw new GithubWebhookPayloadError(detail);
  }
  return value;
}

function optionalDate(value: unknown, detail: string): string | undefined {
  const text = optionalString(value, detail, 64);
  if (text === undefined) return undefined;
  if (Number.isNaN(Date.parse(text))) throw new GithubWebhookPayloadError(detail);
  return text;
}

function requirePositiveInt(value: unknown, detail: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new GithubWebhookPayloadError(detail);
  }
  return value;
}

/** owner/repo 两段校验，避免构造出非法 PR 标识 */
function requireFullName(value: unknown): string {
  const fullName = requireString(value, 'repository.full_name', 512);
  const segments = fullName.split('/');
  if (
    segments.length !== 2 ||
    segments.some((s) => s.length === 0 || s === '.' || s === '..')
  ) {
    throw new GithubWebhookPayloadError('repository.full_name');
  }
  return fullName;
}

/**
 * GitHub `pull_request_review` 事件 → 平台归一化载荷（纯函数）。
 * - action 非 `submitted`：返回 null（安全忽略，响应 UNSUPPORTED_EVENT）；
 * - 字段缺失/非法：抛 GithubWebhookPayloadError（响应 400，detail 为字段路径）。
 * eventId 取 review.id（跨重投稳定），复投由既有判定链判 DUPLICATE_EVENT。
 */
export function parseGithubReviewEvent(raw: Buffer | string): EventCallbackPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    throw new GithubWebhookPayloadError('json');
  }
  if (!isRecord(parsed)) throw new GithubWebhookPayloadError('body');

  const action = requireString(parsed.action, 'action', 64);
  if (action !== 'submitted') return null;

  if (!isRecord(parsed.review)) throw new GithubWebhookPayloadError('review');
  const review = parsed.review;
  const reviewId = requirePositiveInt(review.id, 'review.id');
  const reviewState = requireString(review.state, 'review.state', 64);

  if (!isRecord(parsed.repository)) throw new GithubWebhookPayloadError('repository');
  const fullName = requireFullName(parsed.repository.full_name);

  if (!isRecord(parsed.pull_request)) throw new GithubWebhookPayloadError('pull_request');
  const pullRequest = parsed.pull_request;
  const number = requirePositiveInt(pullRequest.number, 'pull_request.number');
  const prUrl = optionalString(pullRequest.html_url, 'pull_request.html_url', 2048);

  const comment = optionalString(review.body, 'review.body', 64_000);
  let reviewer: string | undefined;
  if (review.user !== undefined && review.user !== null) {
    if (!isRecord(review.user)) throw new GithubWebhookPayloadError('review.user');
    reviewer = optionalString(review.user.login, 'review.user.login', 256);
  }
  const submittedAt = optionalDate(review.submitted_at, 'review.submitted_at');

  return {
    eventType: 'pull_request',
    eventId: `gh:pull_request_review:${reviewId}`,
    ...(submittedAt ? { occurredAt: submittedAt } : {}),
    payload: {
      pullRequestId: `${fullName}#${number}`,
      reviewState,
      action: 'reviewed',
      ...(prUrl ? { prUrl } : {}),
      ...(comment ? { comment } : {}),
      ...(reviewer ? { reviewer } : {}),
      ...(submittedAt ? { submittedAt } : {}),
    },
  };
}
