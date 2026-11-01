/**
 * T-OBS5 mixin 与 child / 上下文合并语义；T-OBS9 traceparent 编解码。
 */
import { describe, it, expect } from 'vitest';
import { readContext, runWithLogContext } from './log-context.js';
import { createTestLogger } from './testing.js';
import {
  extractTraceparent,
  injectTraceparent,
  parseTraceparent,
  publishJson,
  withSpan,
  currentTraceIds,
} from './trace.js';

describe('T-OBS5 mixin 与 child', () => {
  it('上下文内自动带 requestId/userId 等字段', () => {
    const { logger, records } = createTestLogger();
    runWithLogContext({ requestId: 'req-1', userId: 'u-1', tenantId: 't-1' }, () => {
      logger.info({}, 'in context');
    });
    logger.info({}, 'out of context');
    expect(records[0].requestId).toBe('req-1');
    expect(records[0].userId).toBe('u-1');
    expect(records[0].tenantId).toBe('t-1');
    expect(records[1].requestId).toBeUndefined();
    expect(records[1].userId).toBeUndefined();
  });

  it('child component 合并', () => {
    const { logger, records } = createTestLogger();
    const child = logger.child({ component: 'socketio' });
    runWithLogContext({ requestId: 'req-2' }, () => {
      child.warn({ event: 'x' }, 'child log');
    });
    expect(records[0].component).toBe('socketio');
    expect(records[0].event).toBe('x');
    expect(records[0].requestId).toBe('req-2');
  });

  it('嵌套 runWithLogContext 合并且已有键不被覆盖', () => {
    runWithLogContext({ requestId: 'outer', userId: 'u-outer' }, () => {
      runWithLogContext({ requestId: 'inner', sessionId: 's-1' }, () => {
        const ctx = readContext();
        expect(ctx.requestId).toBe('outer');
        expect(ctx.userId).toBe('u-outer');
        expect(ctx.sessionId).toBe('s-1');
      });
    });
  });

  it('上下文外 readContext 返回空对象不报错', () => {
    expect(readContext()).toEqual({});
  });

  it('createTestLogger 默认 component 生效', () => {
    const { logger, records } = createTestLogger('migration/001');
    logger.info({}, 'm');
    expect(records[0].component).toBe('migration/001');
  });
});

describe('T-OBS9 traceparent 编解码', () => {
  const valid = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

  it('parse/extract 往返一致', () => {
    const sc = parseTraceparent(valid);
    expect(sc).toBeDefined();
    expect(sc?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(sc?.spanId).toBe('00f067aa0ba902b7');
    expect(extractTraceparent({ traceparent: valid })).toBe(valid);
  });

  it('大小写与空白容错', () => {
    expect(extractTraceparent({ traceparent: `  ${valid.toUpperCase()} ` })).toBe(valid);
  });

  it('非法格式（长度/字符/版本/零值）返回 undefined', () => {
    const bad = [
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7', // 缺 flags
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-011', // flags 超长
      'zz-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', // 非 hex
      '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', // 版本
      '00-00000000000000000000000000000000-00f067aa0ba902b7-01', // 零 traceId
      '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01', // 零 spanId
      '',
    ];
    for (const v of bad) {
      expect(parseTraceparent(v), v).toBeUndefined();
      expect(extractTraceparent({ traceparent: v }), v).toBeUndefined();
    }
    expect(extractTraceparent(undefined)).toBeUndefined();
    expect(extractTraceparent({})).toBeUndefined();
    expect(extractTraceparent({ traceparent: 123 })).toBeUndefined();
  });

  it('injectTraceparent：无活跃 span 不注入无效值', () => {
    const carrier = injectTraceparent({});
    expect(carrier.traceparent).toBeUndefined();
    expect(currentTraceIds()).toEqual({});
  });

  it('withSpan 无 SDK 时退化为直接调用（返回值与异常语义不变）', () => {
    expect(withSpan('noop.span', {}, () => 42)).toBe(42);
    expect(() =>
      withSpan('noop.err', {}, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
  });
});

describe('T-OBS22 publishJson 封套', () => {
  it('注入 _meta.traceparent（无活跃 span 时保留既有 _meta、不注入无效值）', () => {
    const calls: Array<[string, string]> = [];
    const publish = (channel: string, body: string): number => {
      calls.push([channel, body]);
      return 1;
    };
    publishJson(publish, 'session:message', { sessionId: 's-1', _meta: { other: 'x' } });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('session:message');
    const body = JSON.parse(calls[0][1]) as Record<string, unknown>;
    expect(body.sessionId).toBe('s-1');
    expect((body._meta as Record<string, unknown>).other).toBe('x');
    expect((body._meta as Record<string, unknown>).traceparent).toBeUndefined();
  });
});
