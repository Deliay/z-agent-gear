/**
 * T-OBS17 采样：`OTEL_TRACES_SAMPLER_ARG=0` 无 span；
 * parentbased——父已采样则子跟随（同 traceId）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { context, trace, TraceFlags } from '@opentelemetry/api';

import { startTelemetry, shutdownTelemetry } from './telemetry.js';
import { RecordingExporter } from './recording-exporter.js';
import { withSpan } from './trace.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('T-OBS17 采样', () => {
  it('ratio=0 不产生 span；父已采样则子跟随', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:4318');
    vi.stubEnv('OTEL_TRACES_SAMPLER', 'parentbased_traceidratio');
    vi.stubEnv('OTEL_TRACES_SAMPLER_ARG', '0');
    vi.stubEnv('OTEL_METRICS_ENABLED', 'false');
    const mem = new RecordingExporter();
    startTelemetry({ traceExporter: mem });

    withSpan('dropped.span', {}, () => undefined);

    const parentSc = {
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    };
    context.with(trace.setSpanContext(context.active(), parentSc), () => {
      withSpan('followed.span', {}, () => undefined);
    });

    await shutdownTelemetry();
    const spans = mem.spans;
    const names = spans.map((s) => s.name);
    expect(names).not.toContain('dropped.span');
    expect(names).toContain('followed.span');
    expect(spans.find((s) => s.name === 'followed.span')?.spanContext().traceId).toBe(parentSc.traceId);
  });
});
