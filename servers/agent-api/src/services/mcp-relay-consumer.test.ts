import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('./mcp-dispatch.js', () => ({
  dispatch: vi.fn(),
}));

import { getRedisClient } from '../middleware/redis.js';
import { dispatch } from './mcp-dispatch.js';
import { mcpRelayConsumer } from './mcp-relay-consumer.js';

let baseRedis: { duplicate: ReturnType<typeof vi.fn>; publish: ReturnType<typeof vi.fn> };
let subscriber: {
  subscribe: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(baseRedis.publish).toHaveBeenCalledWith(
      'mcp:relay:response:req-1',
      JSON.stringify({ requestId: 'req-1', status: 200, body: { jsonrpc: '2.0', id: 1, result: {} } }),
    );
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