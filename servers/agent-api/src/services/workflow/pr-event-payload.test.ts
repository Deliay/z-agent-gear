import { describe, it, expect } from 'vitest';
import { parseEventCallbackPayload, EventPayloadError } from './pr-event-payload.js';

const valid = {
  eventType: 'pull_request',
  eventId: 'evt-1',
  occurredAt: '2026-10-23T06:00:00Z',
  payload: {
    pullRequestId: 'a/b#1',
    reviewState: 'approved',
    comment: 'ok',
    reviewer: 'alice',
    submittedAt: '2026-10-23T06:00:00Z',
  },
};

describe('parseEventCallbackPayload', () => {
  it('合法载荷解析全字段', () => {
    const parsed = parseEventCallbackPayload(Buffer.from(JSON.stringify(valid)));
    expect(parsed.eventId).toBe('evt-1');
    expect(parsed.payload.reviewState).toBe('approved');
    expect(parsed.payload.reviewer).toBe('alice');
  });

  it('可选字段缺省', () => {
    const parsed = parseEventCallbackPayload(
      Buffer.from(JSON.stringify({ eventType: 'pull_request', eventId: 'e', payload: { pullRequestId: 'a/b#1', reviewState: 'commented' } })),
    );
    expect(parsed.occurredAt).toBeUndefined();
    expect(parsed.payload.prUrl).toBeUndefined();
  });

  it.each([
    ['非法 JSON', 'not-json', 'json'],
    ['非 pull_request', JSON.stringify({ ...valid, eventType: 'push' }), 'eventType'],
    ['空 eventId', JSON.stringify({ ...valid, eventId: '' }), 'eventId'],
    ['缺 pullRequestId', JSON.stringify({ ...valid, payload: { ...valid.payload, pullRequestId: '' } }), 'payload.pullRequestId'],
    ['缺 reviewState', JSON.stringify({ ...valid, payload: { ...valid.payload, reviewState: undefined } }), 'payload.reviewState'],
    ['非法 occurredAt', JSON.stringify({ ...valid, occurredAt: 'not-a-date' }), 'occurredAt'],
    ['非法 submittedAt', JSON.stringify({ ...valid, payload: { ...valid.payload, submittedAt: 'nope' } }), 'payload.submittedAt'],
  ])('%s → 400 detail=%s', (_label, raw, detail) => {
    expect(() => parseEventCallbackPayload(Buffer.from(raw))).toThrow(EventPayloadError);
    try {
      parseEventCallbackPayload(Buffer.from(raw));
    } catch (err) {
      expect((err as EventPayloadError).detail).toBe(detail);
    }
  });
});
