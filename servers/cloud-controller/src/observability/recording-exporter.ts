/**
 * 测试用 RecordingExporter：shutdown 不清空（sdk-trace 3.0 的 InMemorySpanExporter
 * 会在 shutdown 时清空已收集 span，不适用于「先 shutdown 再断言」的用例）。
 */
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';

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
