/**
 * T-OBS12 httpContext：x-request-id 沿用/非法重生成/缺失生成、响应头回写、
 * 访问日志含 status/durationMs、/health 降噪、span 名含方法与路由、SSE 连接级日志。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { httpContext, normalizeRequestId, type HttpContextRequest, type HttpContextResponse } from './http-context.js';
import { startTelemetry, shutdownTelemetry } from './telemetry.js';
import { RecordingExporter } from './recording-exporter.js';
import { createTestLogger } from './testing.js';

interface FakeRes extends HttpContextResponse {
  headers: Record<string, string>;
  emit(event: string): void;
}

function makeReq(overrides: Partial<HttpContextRequest> = {}): HttpContextRequest {
  return {
    method: 'GET',
    path: '/graphql',
    url: '/graphql',
    headers: {},
    ...overrides,
  };
}

function makeRes(): FakeRes {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    statusCode: 200,
    headers: {},
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    on(event: string, listener: () => void) {
      (listeners[event] ??= []).push(listener);
      return this;
    },
    emit(event: string) {
      for (const l of listeners[event] ?? []) l();
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('T-OBS12 httpContext', () => {
  it('入站合法 x-request-id 沿用；缺失生成 UUID；非法生成并标注替换', () => {
    const t = createTestLogger();
    const mw = httpContext({ logger: t.logger });

    const res1 = makeRes();
    mw(makeReq({ headers: { 'x-request-id': 'valid-id-12345' } }), res1, () => undefined);
    expect(res1.headers['x-request-id']).toBe('valid-id-12345');
    res1.emit('finish');

    const res2 = makeRes();
    mw(makeReq(), res2, () => undefined);
    expect(res2.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    res2.emit('finish');

    const res3 = makeRes();
    mw(makeReq({ headers: { 'x-request-id': 'bad id!' } }), res3, () => undefined);
    expect(res3.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    res3.emit('finish');

    const recs = t.records.filter((r) => r.msg === 'request completed');
    expect(recs).toHaveLength(3);
    expect(recs[0].requestId).toBe('valid-id-12345');
    expect(recs[0].requestIdReplaced).toBeUndefined();
    expect(recs[2].requestIdReplaced).toBe(true);
    for (const r of recs) {
      expect(typeof r.status).toBe('number');
      expect(typeof r.durationMs).toBe('number');
    }
  });

  it('normalizeRequestId 判定口径（D5）', () => {
    expect(normalizeRequestId('abc12345')).toEqual({ requestId: 'abc12345', replaced: false });
    expect(normalizeRequestId('short')).toEqual({ requestId: expect.any(String), replaced: true });
    expect(normalizeRequestId(undefined).replaced).toBe(false);
    expect(normalizeRequestId('has space 123').replaced).toBe(true);
  });

  it('/health 以 debug 记录；业务请求 info', () => {
    const t = createTestLogger();
    const mw = httpContext({ logger: t.logger });
    const resHealth = makeRes();
    mw(makeReq({ path: '/health', url: '/health' }), resHealth, () => undefined);
    resHealth.emit('finish');
    const resGql = makeRes();
    mw(makeReq(), resGql, () => undefined);
    resGql.emit('finish');
    const levels = t.records.filter((r) => r.msg === 'request completed').map((r) => r.level);
    expect(levels).toEqual(['debug', 'info']);
  });

  it('SSE 只记连接建立与断开各一条', () => {
    const t = createTestLogger();
    const mw = httpContext({ logger: t.logger });
    const res = makeRes();
    mw(makeReq({ path: '/api/session-stream', url: '/api/session-stream' }), res, () => undefined);
    res.emit('close');
    expect(t.records.filter((r) => r.msg === 'sse connected')).toHaveLength(1);
    expect(t.records.filter((r) => r.msg === 'sse disconnected')).toHaveLength(1);
    expect(t.records.filter((r) => r.msg === 'request completed')).toHaveLength(0);
  });

  it('span 名含方法与路由，5xx 置 ERROR', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:4318');
    vi.stubEnv('OTEL_METRICS_ENABLED', 'false');
    const mem = new RecordingExporter();
    startTelemetry({ traceExporter: mem });

    const t = createTestLogger();
    const mw = httpContext({ logger: t.logger });
    const res = makeRes();
    mw(makeReq({ method: 'POST', path: '/graphql' }), res, () => {
      res.statusCode = 500;
    });
    res.emit('finish');
    // httpContext 的 span 在响应结束的微任务中关闭，先排干微任务再 shutdown
    await new Promise((resolve) => setTimeout(resolve, 0));
    await shutdownTelemetry();

    const span = mem.spans.find((s) => s.name === 'POST /graphql');
    expect(span).toBeDefined();
    expect(span?.attributes['http.response.status_code']).toBe(500);
    expect(span?.status.code).toBe(2); // ERROR
  });
});
