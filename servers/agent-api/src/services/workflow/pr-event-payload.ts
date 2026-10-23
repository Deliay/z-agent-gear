/** 事件回调载荷（`pull_request` 审核事件的最小契约） */
export interface EventCallbackPayload {
  eventType: 'pull_request';
  eventId: string;
  occurredAt?: string;
  payload: {
    pullRequestId: string;
    prUrl?: string;
    action?: string;
    reviewState: string;
    comment?: string;
    reviewer?: string;
    submittedAt?: string;
  };
}

/** 载荷校验失败：detail 为字段路径（响应 400 payload.invalid） */
export class EventPayloadError extends Error {
  constructor(public readonly detail: string) {
    super(`payload.invalid: ${detail}`);
    this.name = 'EventPayloadError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, detail: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EventPayloadError(detail);
  }
  return value;
}

function optionalString(value: unknown, detail: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new EventPayloadError(detail);
  return value;
}

function optionalDate(value: unknown, detail: string): string | undefined {
  const text = optionalString(value, detail);
  if (text === undefined) return undefined;
  if (Number.isNaN(Date.parse(text))) throw new EventPayloadError(detail);
  return text;
}

/**
 * 手写载荷校验（不引入 zod）。纯函数：解析失败/字段缺失抛 EventPayloadError。
 * reviewState 只校验类型，枚举外的值由事件处理器判为 UNSUPPORTED_REVIEW_STATE。
 */
export function parseEventCallbackPayload(raw: Buffer | string): EventCallbackPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    throw new EventPayloadError('json');
  }
  if (!isRecord(parsed)) throw new EventPayloadError('body');

  const eventType = requireString(parsed.eventType, 'eventType');
  if (eventType !== 'pull_request') {
    throw new EventPayloadError('eventType');
  }
  const eventId = requireString(parsed.eventId, 'eventId');
  const occurredAt = optionalDate(parsed.occurredAt, 'occurredAt');

  if (!isRecord(parsed.payload)) throw new EventPayloadError('payload');
  const payload = parsed.payload;
  const pullRequestId = requireString(payload.pullRequestId, 'payload.pullRequestId');
  const reviewState = requireString(payload.reviewState, 'payload.reviewState');

  return {
    eventType: 'pull_request',
    eventId,
    ...(occurredAt ? { occurredAt } : {}),
    payload: {
      pullRequestId,
      reviewState,
      prUrl: optionalString(payload.prUrl, 'payload.prUrl'),
      action: optionalString(payload.action, 'payload.action'),
      comment: optionalString(payload.comment, 'payload.comment'),
      reviewer: optionalString(payload.reviewer, 'payload.reviewer'),
      submittedAt: optionalDate(payload.submittedAt, 'payload.submittedAt'),
    },
  };
}
