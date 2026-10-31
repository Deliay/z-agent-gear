/**
 * T-OBS11 SDK 启动/关闭：有 endpoint → 导出器收到 span；
 * `shutdownTelemetry()` 幂等且 2s 内返回。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { startTelemetry, shutdownTelemetry } from './telemetry.js';
import { RecordingExporter } from './recording-exporter.js';
import { currentTraceIds, withSpan } from './trace.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('T-OBS11 SDK 启停', () => {
  it('有 endpoint：span 进入导出器、trace id 可取；shutdown 幂等且 <2s', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:4318');
    vi.stubEnv('OTEL_METRICS_ENABLED', 'false');
    const mem = new RecordingExporter();
    startTelemetry({ traceExporter: mem });

    const value = await withSpan('t-obs11.span', { 'test.attr': 'v' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(currentTraceIds().traceId).toBeDefined();
      return 'done';
    });
    expect(value).toBe('done');

    await shutdownTelemetry();
    const names = mem.spans.map((s) => s.name);
    expect(names).toContain('t-obs11.span');
    expect(mem.spans[0].attributes['test.attr']).toBe('v');

    const t0 = Date.now();
    await shutdownTelemetry();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
