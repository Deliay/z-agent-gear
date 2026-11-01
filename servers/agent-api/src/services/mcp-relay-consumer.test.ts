import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';

const { logRecords } = vi.hoisted(() => ({
  logRecords: [] as Array<{ level: string; fields: Record<string, unknown>; msg: string }>,
}));

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('./mcp-dispatch.js', () => ({
  dispatch: vi.fn(),
}));

// 日志内存 sink：断言 B4（响应正文不入日志）等结构化字段
vi.mock('../observability/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../observability/logger.js')>();
  const sink = {
    debug: (fields: Record<string, unknown>, msg: string) => logRecords.push({ level: 'debug', fields, msg }),
    info: (fields: Record<string, unknown>, msg: string) => logRecords.push({ level: 'info', fields, msg }),
    warn: (fields: Record<string, unknown>, msg: string) => logRecords.push({ level: 'warn', fields, msg }),
    error: (fields: Record<string, unknown>, msg: string) => logRecords.push({ level: 'error', fields, msg }),
    fatal: (fields: Record<string, unknown>, msg: string) => logRecords.push({ level: 'fatal', fields, msg }),
    child: () => sink,
  };
  return { ...actual, logger: sink };
});

import { getRedisClient } from '../middleware/redis.js';
import { dispatch } from './mcp-dispatch.js';
import { mcpRelayConsumer } from './mcp-relay-consumer.js';
import { RecordingExporter } from '../observability/recording-exporter.js';

const mem = new RecordingExporter();

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: mem })] }));
});

let baseRedis: { duplicate: ReturnType<typeof vi.fn>; publish: ReturnType<typeof vi.fn> };
let subscriber: {
  subscribe: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  logRecords.length = 0;
  subscriber = {
    subscribe: vi.fn().mockResolvedValue('OK'),
    on: vi.fn(),
    unsubscribe: vi.fn().mockResolvedValue('OK'),
    disconnect: vi.fn(),
  };
  baseRedis = {
    duplicate: vi.fn().mockReturnValue(subscriber),
    publish: vi.fn().mockResolvedValue(1),
  };
  vi.mocked(getRedisClient).mockReturnValue(baseRedis as never);
});

afterEach(async () => {
  await mcpRelayConsumer.stop();
});

function emitMessage(message: unknown): Promise<void> {
  const handler = subscriber.on.mock.calls.find(c => c[0] === 'message')?.[1] as
    (channel: string, message: string) => Promise<void>;
  return handler('mcp:relay:request', JSON.stringify(message));
}

describe('McpRelayConsumer', () => {
  it('T-A1: 收到 mcp:relay:request 时调用 dispatch 并 publish 响应到 mcp:relay:response:{requestId}', async () => {
    vi.mocked(dispatch).mockResolvedValue({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } });
    mcpRelayConsumer.start();

    await emitMessage({
      requestId: 'req-1',
      sessionId: 'sess-1',
      serverName: 'github-mcp',
      token: 'tok',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
    });

    expect(dispatch).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      serverName: 'github-mcp',
      token: 'tok',
      body: expect.objectContaining({ method: 'tools/call' }),
    });
    expect(baseRedis.publish).toHaveBeenCalledWith('mcp:relay:response:req-1', expect.any(String));
    const { _meta, ...relayBody } = JSON.parse(baseRedis.publish.mock.calls[0][1]);
    expect(relayBody).toEqual({ requestId: 'req-1', status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } });
  });

  it('T-A2: dispatch 抛非预期异常时 publish {status:502, body:FORWARD_ERROR}，进程不崩', async () => {
    vi.mocked(dispatch).mockRejectedValue(new Error('boom'));
    mcpRelayConsumer.start();

    await emitMessage({
      requestId: 'req-2',
      sessionId: 'sess-1',
      serverName: 'github-mcp',
      token: 'tok',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
    });

    const publishCall = baseRedis.publish.mock.calls.find(c => c[0] === 'mcp:relay:response:req-2');
    expect(publishCall).toBeDefined();
    const payload = JSON.parse(publishCall![1] as string);
    expect(payload.requestId).toBe('req-2');
    expect(payload.status).toBe(502);
    expect(payload.body.error.code).toBe('FORWARD_ERROR');
  });

  it('T-A3: platform 工具经 relay 链路返回正确结果（工作流 MCP 能力不断链）', async () => {
    vi.mocked(dispatch).mockResolvedValue({
      status: 200,
      body: { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'getCurrentNodeId' }] } },
    });
    mcpRelayConsumer.start();

    await emitMessage({
      requestId: 'req-3',
      sessionId: 'sess-1',
      serverName: 'agent-workflow-tools',
      token: 'tok',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ serverName: 'agent-workflow-tools' }));
    const publishCall = baseRedis.publish.mock.calls.find(c => c[0] === 'mcp:relay:response:req-3');
    const payload = JSON.parse(publishCall![1] as string);
    expect(payload.status).toBe(200);
    expect(payload.body.result.tools).toHaveLength(1);
  });
});

const A4_TRACE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const A4_PARENT_SPAN_ID = '0123456789abcdef';

describe('T-OBS A4 mcp:relay:request 订阅回调链路传播', () => {
  it('handle span 以 _meta.traceparent 为父链路（同 trace、父 span id 对齐），回包 _meta.traceparent 延续同一 trace', async () => {
    vi.mocked(dispatch).mockResolvedValue({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } });
    mcpRelayConsumer.start();

    await emitMessage({
      requestId: 'req-a4-1',
      sessionId: 'sess-1',
      serverName: 'github-mcp',
      token: 'tok',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
      _meta: { traceparent: `00-${A4_TRACE_ID}-${A4_PARENT_SPAN_ID}-01` },
    });

    // span 父子关系：发布侧 trace 与 span id 在消费侧延续
    const span = mem.spans.find(
      (s) => s.name === 'mcp:relay:request handle' && s.attributes.requestId === 'req-a4-1',
    );
    expect(span).toBeDefined();
    expect(span!.spanContext().traceId).toBe(A4_TRACE_ID);
    expect(span!.parentSpanContext?.spanId).toBe(A4_PARENT_SPAN_ID);
    expect(span!.parentSpanContext?.isRemote).toBe(true);

    // `_meta.traceparent` 断言：回包封套注入的是 handle span 自身，同 trace 双向不断链
    const publishCall = baseRedis.publish.mock.calls.find(c => c[0] === 'mcp:relay:response:req-a4-1');
    expect(publishCall).toBeDefined();
    const payload = JSON.parse(publishCall![1] as string);
    expect(payload._meta.traceparent).toMatch(
      new RegExp(`^00-${A4_TRACE_ID}-[0-9a-f]{16}-01$`),
    );
    expect(payload._meta.traceparent).toContain(`-${span!.spanContext().spanId}-`);
  });

  it('_meta 缺失时容错：handle span 仍创建（回退根链路），dispatch 与回包不受影响', async () => {
    vi.mocked(dispatch).mockResolvedValue({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } });
    mcpRelayConsumer.start();

    await emitMessage({
      requestId: 'req-a4-2',
      sessionId: 'sess-1',
      serverName: 'github-mcp',
      token: 'tok',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
    });

    const span = mem.spans.find(
      (s) => s.name === 'mcp:relay:request handle' && s.attributes.requestId === 'req-a4-2',
    );
    expect(span).toBeDefined();
    expect(span!.parentSpanContext).toBeUndefined();
    expect(dispatch).toHaveBeenCalled();
    expect(baseRedis.publish).toHaveBeenCalledWith('mcp:relay:response:req-a4-2', expect.any(String));
  });

  it('非法 traceparent 一律忽略（视为缺失），不报错', async () => {
    vi.mocked(dispatch).mockResolvedValue({ status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } });
    mcpRelayConsumer.start();

    await emitMessage({
      requestId: 'req-a4-3',
      sessionId: 'sess-1',
      serverName: 'github-mcp',
      token: 'tok',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
      _meta: { traceparent: 'not-a-traceparent' },
    });

    const span = mem.spans.find(
      (s) => s.name === 'mcp:relay:request handle' && s.attributes.requestId === 'req-a4-3',
    );
    expect(span).toBeDefined();
    expect(span!.parentSpanContext).toBeUndefined();
    expect(dispatch).toHaveBeenCalled();
  });
});

describe('T-OBS B4 dispatch 结果日志脱敏', () => {
  it('dispatch-result 日志不落第三方 MCP 响应正文（凭据零泄露）', async () => {
    const secretBody = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ghp_thirdPartySecretValue' }] } };
    vi.mocked(dispatch).mockResolvedValue({ status: 200, body: secretBody });
    mcpRelayConsumer.start();

    await emitMessage({
      requestId: 'req-b4-1',
      sessionId: 'sess-1',
      serverName: 'github-mcp',
      token: 'tok',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
    });

    const result = logRecords.find((r) => r.fields.event === 'dispatch-result');
    expect(result).toBeDefined();
    expect(result!.fields).not.toHaveProperty('body');
    for (const rec of logRecords) {
      expect(JSON.stringify(rec.fields)).not.toContain('ghp_thirdPartySecretValue');
      expect(rec.msg).not.toContain('ghp_thirdPartySecretValue');
    }
  });
});