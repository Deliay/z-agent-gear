// GENERATED FROM packages/observability/src/telemetry.ts — DO NOT EDIT

/**
 * OpenTelemetry SDK 启停（`@opentelemetry/sdk-trace-node` 基线，5 包通用）。
 *
 * - **未配置 `OTEL_EXPORTER_OTLP_ENDPOINT`（或 `OTEL_SDK_DISABLED=true`）= 完全不启动**：
 *   不注册 exporter、不开线程、零外发（契约 §7）；
 * - 采样 `parentbased_traceidratio`（`OTEL_TRACES_SAMPLER_ARG`，默认 1.0）；
 * - metrics 与 auto-instrumentations 为**动态可选**（agent-gear 精简依赖不含它们，见 D2/D7）；
 * - `shutdownTelemetry()` 幂等、2s 上限；SIGTERM/SIGINT 冲刷后放行原信号语义。
 */
import { createRequire } from 'node:module';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  TracerProvider,
  type Sampler,
  type SpanExporter,
} from '@opentelemetry/sdk-trace';
import { SERVICE_NAME, SERVICE_VERSION, logger } from './logger.js';

const require = createRequire(import.meta.url);

let started = false;
let shutdownPromise: Promise<void> | undefined;
let shutdownProvider: { shutdown(): Promise<void> } | undefined;
let shutdownMeter: { shutdown(): Promise<void> } | undefined;

function parseHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const idx = pair.indexOf('=');
    if (idx > 0) headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return headers;
}

function parseResourceAttributes(raw: string | undefined): Record<string, string> {
  return parseHeaders(raw); // 同为 k=v 逗号分隔
}

function tracesUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '');
  return base.endsWith('/v1/traces') ? base : `${base}/v1/traces`;
}

function metricsUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, '');
  return base.endsWith('/v1/metrics') ? base : `${base}/v1/metrics`;
}

function buildSampler(): Sampler {
  const name = (process.env.OTEL_TRACES_SAMPLER ?? 'parentbased_traceidratio').trim();
  const rawArg = (process.env.OTEL_TRACES_SAMPLER_ARG ?? '').trim();
  const arg = Number(rawArg === '' ? '1.0' : rawArg);
  const ratio = Number.isFinite(arg) ? Math.min(1, Math.max(0, arg)) : 1.0;
  switch (name) {
    case 'always_on':
      return new AlwaysOnSampler();
    case 'always_off':
      return new AlwaysOffSampler();
    case 'traceidratio':
      return new TraceIdRatioBasedSampler(ratio);
    case 'parentbased_traceidratio':
    default:
      return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
  }
}

function buildResource(): Resource {
  return resourceFromAttributes({
    'service.name': SERVICE_NAME,
    'service.version': SERVICE_VERSION,
    'deployment.environment': process.env.NODE_ENV ?? 'development',
    ...parseResourceAttributes(process.env.OTEL_RESOURCE_ATTRIBUTES),
  });
}

/**
 * 启动 OTel SDK。已启动则直接返回（幂等）。
 * 无 endpoint / 显式关闭 → 立即返回（完全不启动，零外发）。
 * `opts.traceExporter` 仅供测试注入 InMemory 导出器。
 */
export function startTelemetry(opts: { traceExporter?: SpanExporter } = {}): void {
  if (started) return;
  started = true;
  const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim();
  if (!endpoint || process.env.OTEL_SDK_DISABLED === 'true') return;

  const exporter: SpanExporter =
    opts.traceExporter ??
    new OTLPTraceExporter({
      url: tracesUrl(endpoint),
      headers: parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
      timeoutMillis: Number(process.env.OTEL_EXPORT_TIMEOUT_MS ?? '5000') || 5000,
      concurrencyLimit: 8,
    });
  const provider = new TracerProvider({
    resource: buildResource(),
    sampler: buildSampler(),
    spanProcessors: [new BatchSpanProcessor({ exporter })],
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  shutdownProvider = provider;
  logger.debug({ component: 'observability', otlpEndpoint: tracesUrl(endpoint) }, 'telemetry started');

  // metrics：依赖缺失（agent-gear）或显式关闭则不注册（D10）
  if (process.env.OTEL_METRICS_ENABLED !== 'false') {
    try {
      const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
      const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
      const meterProvider = new MeterProvider({
        resource: buildResource(),
        readers: [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({
              url: metricsUrl(endpoint),
              headers: parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
            }),
            exportIntervalMillis: 60_000,
          }),
        ],
      });
      metrics.setGlobalMeterProvider(meterProvider);
      shutdownMeter = meterProvider;
    } catch {
      // 指标依赖不可用：仅追踪，不报错
    }
  }

  // auto-instrumentations：依赖缺失（agent-gear）则跳过（D2/D7）
  try {
    const { registerInstrumentations } = require('@opentelemetry/instrumentation');
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
    registerInstrumentations({
      instrumentations: [getNodeAutoInstrumentations()],
      tracerProvider: provider,
      meterProvider: shutdownMeter,
    });
  } catch {
    // 自动埋点不可用：手工 span 不受影响
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const handler = (): void => {
      void shutdownTelemetry().finally(() => {
        process.removeListener(signal, handler);
        process.kill(process.pid, signal);
      });
    };
    process.on(signal, handler);
  }
}

/** 冲刷并关闭 SDK。幂等；单次最多 2s（超时放弃，不阻塞进程退出）。 */
export function shutdownTelemetry(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  const provider = shutdownProvider;
  const meter = shutdownMeter;
  shutdownPromise = (async () => {
    const tasks: Promise<unknown>[] = [];
    if (provider) tasks.push(provider.shutdown().catch(() => undefined));
    if (meter) tasks.push(meter.shutdown().catch(() => undefined));
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise((resolve) => setTimeout(resolve, 2000).unref?.()),
    ]);
  })();
  return shutdownPromise;
}
