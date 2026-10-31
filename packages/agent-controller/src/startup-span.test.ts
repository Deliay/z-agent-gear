import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { shutdownTelemetry, startTelemetry } from './observability/telemetry.js';
import { startupLinks, withStartupSpan } from './startup-span.js';

/**
 * 本地 RecordingExporter（T-OBS18）：自维护数组留存导出快照。
 * 不用 InMemorySpanExporter——其 `shutdown()` 会清空缓冲，shutdown 后读不到。
 */
function createRecordingExporter(): { exporter: SpanExporter; spans: ReadableSpan[] } {
  const spans: ReadableSpan[] = [];
  return {
    spans,
    exporter: {
      export(batch: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
        spans.push(...batch);
        resultCallback({ code: ExportResultCode.SUCCESS });
      },
      async shutdown(): Promise<void> {},
      async forceFlush(): Promise<void> {},
    },
  };
}

const INIT_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('startup span links (T-OBS18)', () => {
  it('ZAG_INIT_TRACEPARENT 合法值产生 link；缺失/非法不产生 links', () => {
    expect(startupLinks({ ZAG_INIT_TRACEPARENT: INIT_TRACEPARENT })).toEqual([
      {
        context: {
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          spanId: '00f067aa0ba902b7',
          traceFlags: 1,
          isRemote: true,
        },
      },
    ]);
    expect(startupLinks({})).toEqual([]);
    expect(startupLinks({ ZAG_INIT_TRACEPARENT: 'not-a-traceparent' })).toEqual([]);
    expect(startupLinks({ ZAG_INIT_TRACEPARENT: '00-zeros-zeros-01' })).toEqual([]);
  });

  describe('withStartupSpan + RecordingExporter', () => {
    const recording = createRecordingExporter();

    beforeAll(() => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
      delete process.env.OTEL_SDK_DISABLED;
      startTelemetry({ traceExporter: recording.exporter });
    });

    afterAll(async () => {
      await shutdownTelemetry();
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    });

    it('ZAG_INIT_TRACEPARENT 存在时 startup span 的 links[0].context.traceId 与注入值一致；缺失时无 links', async () => {
      // case A：注入 ZAG_INIT_TRACEPARENT
      process.env.ZAG_INIT_TRACEPARENT = INIT_TRACEPARENT;
      await withStartupSpan({ 'agent.mode': 'test' }, () => undefined);

      // case B：未注入
      delete process.env.ZAG_INIT_TRACEPARENT;
      await withStartupSpan({ 'agent.mode': 'test' }, () => undefined);

      // BatchSpanProcessor 在 shutdown 时冲刷 → RecordingExporter 自维护数组内可读
      await shutdownTelemetry();

      const startups = recording.spans.filter((s) => s.name === 'startup');
      expect(startups).toHaveLength(2);

      // T-OBS18：links[0].context.traceId 等于注入值的 trace-id（link 而非 parent）
      expect(startups[0].links).toHaveLength(1);
      expect(startups[0].links[0].context.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
      expect(startups[0].links[0].context.spanId).toBe('00f067aa0ba902b7');

      // 未注入：无 links（不注入无效上下文）
      expect(startups[1].links).toHaveLength(0);
    });
  });
});
