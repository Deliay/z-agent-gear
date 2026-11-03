/**
 * 测试支撑（仅测试引用）：
 * - `RecordingExporter`：自维护数组的 span 导出器——sdk-trace 3.x 的 InMemorySpanExporter
 *   在 `shutdown()` 时会清空已收集 span，不适用于「先 shutdown 再断言」的用例；
 * - `installSpanCapture()`：幂等注册测试用 TracerProvider（`SimpleSpanProcessor` 即时导出，
 *   无需 shutdown 再读）与 AsyncLocalStorage 上下文管理器，返回共享捕获器。
 */
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import {
  SimpleSpanProcessor,
  TracerProvider,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace';

export class RecordingExporter implements SpanExporter {
  spans: ReadableSpan[] = [];

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.spans.push(...spans);
    setTimeout(() => resultCallback({ code: ExportResultCode.SUCCESS }), 0);
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  names(): string[] {
    return this.spans.map((s) => s.name);
  }
}

export interface SpanCapture {
  exporter: RecordingExporter;
  /** 清空已收集 span（每个用例前调用，避免跨用例串扰） */
  reset(): void;
  /** 按 span 名取（最近一个） */
  find(name: string): ReadableSpan | undefined;
  names(): string[];
}

let capture: SpanCapture | undefined;

/** 幂等安装测试追踪捕获；重复调用返回同一捕获器（全局 provider 只可注册一次）。 */
export function installSpanCapture(): SpanCapture {
  if (capture) return capture;
  const exporter = new RecordingExporter();
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }));
  capture = {
    exporter,
    reset() {
      exporter.spans.length = 0;
    },
    find(name: string) {
      return exporter.spans.find((s) => s.name === name);
    },
    names() {
      return exporter.spans.map((s) => s.name);
    },
  };
  return capture;
}
