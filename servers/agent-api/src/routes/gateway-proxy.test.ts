import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';

const { redisClientMock, messageHandlers } = vi.hoisted(() => {
  const messageHandlers: Array<(channel: string, message: string) => void> = [];
  const subscriber = {
    subscribe: vi.fn().mockResolvedValue('OK'),
    on: vi.fn((event: string, cb: (channel: string, message: string) => void) => {
      if (event === 'message') messageHandlers.push(cb);
    }),
    off: vi.fn(),
    unsubscribe: vi.fn().mockResolvedValue('OK'),
    disconnect: vi.fn(),
  };
  const redisClientMock = {
    duplicate: vi.fn().mockReturnValue(subscriber),
    publish: vi.fn().mockResolvedValue(1),
  };
  return { redisClientMock, messageHandlers };
});

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(() => redisClientMock),
}));

vi.mock('../services/auth.js', () => ({
  verifyToken: vi.fn(),
}));

vi.mock('../models/user.js', () => ({
  User: {
    findById: vi.fn(),
  },
}));

vi.mock('../models/gateway.js', () => ({
  Gateway: {
    findOne: vi.fn(),
  },
}));

import { verifyToken } from '../services/auth.js';
import { User } from '../models/user.js';
import { Gateway } from '../models/gateway.js';
import { authenticateExpressUser, gatewayProxyRouter } from './gateway-proxy.js';
import { RecordingExporter } from '../observability/recording-exporter.js';

const mem = new RecordingExporter();

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter: mem })] }));
});

beforeEach(() => {
  vi.clearAllMocks();
  messageHandlers.length = 0;
});

function mockReq(overrides: Record<string, unknown> = {}) {
  return {
    headers: {},
    cookies: {},
    ...overrides,
  } as any;
}

describe('authenticateExpressUser', () => {
  it('should authenticate via Authorization header', async () => {
    vi.mocked(verifyToken).mockReturnValue({ userId: 'user1' } as never);
    vi.mocked(User.findById).mockReturnValue({
      select: vi.fn().mockResolvedValue({ _id: { toString: () => 'user1' }, username: 'testuser' }),
    } as never);

    const req = mockReq({ headers: { authorization: 'Bearer valid-jwt' } });
    const result = await authenticateExpressUser(req);

    expect(result).toEqual({ id: 'user1', username: 'testuser' });
    expect(verifyToken).toHaveBeenCalledWith('valid-jwt');
  });

  it('should authenticate via Cookie token', async () => {
    vi.mocked(verifyToken).mockReturnValue({ userId: 'user2' } as never);
    vi.mocked(User.findById).mockReturnValue({
      select: vi.fn().mockResolvedValue({ _id: { toString: () => 'user2' }, username: 'cookieuser' }),
    } as never);

    const req = mockReq({ cookies: { token: 'cookie-jwt' } });
    const result = await authenticateExpressUser(req);

    expect(result).toEqual({ id: 'user2', username: 'cookieuser' });
    expect(verifyToken).toHaveBeenCalledWith('cookie-jwt');
  });

  it('should prefer header over cookie when both present', async () => {
    vi.mocked(verifyToken).mockReturnValue({ userId: 'header-user' } as never);
    vi.mocked(User.findById).mockReturnValue({
      select: vi.fn().mockResolvedValue({ _id: { toString: () => 'header-user' }, username: 'header' }),
    } as never);

    const req = mockReq({
      headers: { authorization: 'Bearer header-jwt' },
      cookies: { token: 'cookie-jwt' },
    });
    const result = await authenticateExpressUser(req);

    expect(result?.id).toBe('header-user');
    expect(verifyToken).toHaveBeenCalledWith('header-jwt');
  });

  it('should return null when neither header nor cookie provided', async () => {
    const req = mockReq();
    const result = await authenticateExpressUser(req);

    expect(result).toBeNull();
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('should return null when Authorization header is not Bearer format', async () => {
    const req = mockReq({ headers: { authorization: 'Basic somecreds' } });
    const result = await authenticateExpressUser(req);

    expect(result).toBeNull();
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it('should return null when token is invalid', async () => {
    vi.mocked(verifyToken).mockImplementation(() => { throw new Error('jwt malformed'); });

    const req = mockReq({ headers: { authorization: 'Bearer bad-jwt' } });
    const result = await authenticateExpressUser(req);

    expect(result).toBeNull();
  });

  it('should return null when user not found', async () => {
    vi.mocked(verifyToken).mockReturnValue({ userId: 'nonexistent' } as never);
    vi.mocked(User.findById).mockReturnValue({
      select: vi.fn().mockResolvedValue(null),
    } as never);

    const req = mockReq({ headers: { authorization: 'Bearer valid-jwt' } });
    const result = await authenticateExpressUser(req);

    expect(result).toBeNull();
  });
});

const A4_TRACE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const A4_PARENT_SPAN_ID = '0123456789abcdef';

type ExpressRouteHandler = (req: unknown, res: unknown) => Promise<void>;

const gatewayRouteHandler = (
  gatewayProxyRouter as unknown as {
    stack: Array<{ route: { stack: Array<{ handle: ExpressRouteHandler }> } }>;
  }
).stack.find((layer) => layer.route)!.route.stack[0].handle;

function mockRouteReq() {
  return {
    method: 'GET',
    headers: { authorization: 'Bearer valid-jwt' },
    cookies: {},
    params: { controllerId: 'ctrl-1', name: 'gw-1', path: ['api', 'status'] },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('request-body');
    },
  };
}

function mockRouteRes(): Record<string, ReturnType<typeof vi.fn>> {
  const res: Record<string, ReturnType<typeof vi.fn>> = {
    status: vi.fn(),
    json: vi.fn(),
    setHeader: vi.fn(),
    send: vi.fn(),
    end: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

function flushPromises(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/** 走完整代理链路：发布 command → 在回包通道投递 responseMessage → 返回 res 与 requestId。 */
async function runProxyRequest(responseMessage: (requestId: string) => Record<string, unknown>) {
  vi.mocked(verifyToken).mockReturnValue({ userId: 'user1' } as never);
  vi.mocked(User.findById).mockReturnValue({
    select: vi.fn().mockResolvedValue({ _id: { toString: () => 'user1' }, username: 'u' }),
  } as never);
  vi.mocked(Gateway.findOne).mockResolvedValue({ port: 8080 } as never);

  const res = mockRouteRes();
  const done = gatewayRouteHandler(mockRouteReq(), res);
  await flushPromises();

  const commandCall = redisClientMock.publish.mock.calls.find((c) => c[0] === 'port-forward:command');
  expect(commandCall).toBeDefined();
  const command = JSON.parse(commandCall![1] as string) as { requestId: string; _meta?: unknown };
  expect(command._meta).toBeDefined();

  const onMessage = messageHandlers[messageHandlers.length - 1];
  onMessage('port-forward:response', JSON.stringify(responseMessage(command.requestId)));
  await done;
  return { res, requestId: command.requestId };
}

describe('gateway proxy T-OBS A4 port-forward:response 回程链路传播', () => {
  it('handle span 以回包 _meta.traceparent 为父链路（同 trace、父 span id 对齐），回程响应正常', async () => {
    const { res, requestId } = await runProxyRequest((rid) => ({
      requestId: rid,
      statusCode: 200,
      headers: { 'x-ok': '1' },
      body: Buffer.from('resp').toString('base64'),
      _meta: { traceparent: `00-${A4_TRACE_ID}-${A4_PARENT_SPAN_ID}-01` },
    }));

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(Buffer.from('resp'));

    const span = mem.spans.find(
      (s) => s.name === 'port-forward:response handle' && s.attributes.requestId === requestId,
    );
    expect(span).toBeDefined();
    expect(span!.spanContext().traceId).toBe(A4_TRACE_ID);
    expect(span!.parentSpanContext?.spanId).toBe(A4_PARENT_SPAN_ID);
    expect(span!.parentSpanContext?.isRemote).toBe(true);
  });

  it('_meta 缺失时容错：handle span 仍创建（回退根链路），回程响应不受影响', async () => {
    const { res, requestId } = await runProxyRequest((rid) => ({
      requestId: rid,
      statusCode: 201,
      headers: {},
      body: Buffer.from('ok').toString('base64'),
    }));

    expect(res.status).toHaveBeenCalledWith(201);
    const span = mem.spans.find(
      (s) => s.name === 'port-forward:response handle' && s.attributes.requestId === requestId,
    );
    expect(span).toBeDefined();
    expect(span!.parentSpanContext).toBeUndefined();
  });
});
