/**
 * T-OBS10 SDK 关闭态：无 endpoint → 完全不启动（无 exporter、零外发、
 * `currentTraceIds()` 为空、业务零异常）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { startTelemetry, shutdownTelemetry } from './telemetry.js';
import { currentTraceIds, withSpan } from './trace.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('T-OBS10 SDK 关闭态', () => {
  it('未配置 endpoint：不启动、无 trace id、业务零异常', async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
    vi.stubEnv('OTEL_SDK_DISABLED', '');
    startTelemetry();
    expect(currentTraceIds()).toEqual({});
    const value = withSpan('noop.span', { k: 'v' }, () => 'ok');
    expect(value).toBe('ok');
    expect(currentTraceIds()).toEqual({});
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });

  it('OTEL_SDK_DISABLED=true 时即使配置了 endpoint 也不启动', () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://127.0.0.1:4318');
    vi.stubEnv('OTEL_SDK_DISABLED', 'true');
    startTelemetry();
    expect(currentTraceIds()).toEqual({});
  });
});
