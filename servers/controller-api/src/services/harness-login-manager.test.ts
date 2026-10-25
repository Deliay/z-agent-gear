import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { HarnessLoginManager } from './harness-login-manager.js';
import { HarnessLoginRegistry } from './harness-login-registry.js';
import { getRedisClient } from '../middleware/redis.js';

const mockRedis = {
  publish: vi.fn(),
  subscribe: vi.fn(),
  on: vi.fn(),
  duplicate: vi.fn(),
  disconnect: vi.fn(),
  del: vi.fn(),
};

function createMockSocket(id = 'socket-123') {
  return {
    id,
    data: { userId: 'user-1', controllerId: 'ctrl-1' },
    emit: vi.fn(),
  };
}

const VALID_REQUIRED = {
  requestId: 'req-1',
  serverType: 'kimi_code',
  trigger: 'probe-options',
  url: 'https://kimi.example.com/device?code=abc',
  userCode: 'ABCD-1234',
  expiresInSeconds: 1800,
};

describe('HarnessLoginManager', () => {
  let manager: HarnessLoginManager;
  let registry: HarnessLoginRegistry;
  let io: { sockets: { sockets: Map<string, unknown> } };
  let socket: ReturnType<typeof createMockSocket>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
    mockRedis.duplicate.mockReturnValue(mockRedis);
    mockRedis.publish.mockResolvedValue(1);
    mockRedis.del.mockResolvedValue(1);

    registry = new HarnessLoginRegistry();
    socket = createMockSocket();
    io = { sockets: { sockets: new Map<string, unknown>() } };
    io.sockets.sockets.set(socket.id, socket);

    manager = new HarnessLoginManager({ registry, loginWaitMs: 1_800_000 });
    manager.start(io as never);
  });

  afterEach(() => {
    manager.stop();
  });

  function published(channel: string): Array<Record<string, unknown>> {
    return mockRedis.publish.mock.calls
      .filter((call) => call[0] === channel)
      .map((call) => JSON.parse(call[1] as string) as Record<string, unknown>);
  }

  describe('T-HLM1 入站校验', () => {
    const invalidCases: Array<[string, Record<string, unknown>]> = [
      ['requestId 为空', { ...VALID_REQUIRED, requestId: '' }],
      ['requestId 超长', { ...VALID_REQUIRED, requestId: 'x'.repeat(201) }],
      ['serverType 非 kimi_code', { ...VALID_REQUIRED, serverType: 'opencode' }],
      ['trigger 非法', { ...VALID_REQUIRED, trigger: 'unknown' }],
      ['url 非 http(s)', { ...VALID_REQUIRED, url: 'ftp://kimi.example.com/device' }],
      ['url 超长', { ...VALID_REQUIRED, url: 'https://a.com/' + 'x'.repeat(2048) }],
      ['userCode 超长', { ...VALID_REQUIRED, userCode: 'x'.repeat(65) }],
      ['expiresInSeconds 过小', { ...VALID_REQUIRED, expiresInSeconds: 30 }],
      ['expiresInSeconds 非整数', { ...VALID_REQUIRED, expiresInSeconds: 1800.5 }],
      ['account 超长', { ...VALID_REQUIRED, account: 'x'.repeat(201) }],
    ];

    for (const [name, payload] of invalidCases) {
      it(`丢弃 ${name} 且不发布 Redis`, async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await manager.handleLoginRequired(socket as never, payload as never);
        expect(mockRedis.publish).not.toHaveBeenCalled();
        expect(manager.getPendingCount()).toBe(0);
        expect(registry.pendingFor('ctrl-1')).toBeUndefined();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
      });
    }

    it('缺少 socket 归属时丢弃', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const anonymous = { id: 's2', data: {}, emit: vi.fn() };
      await manager.handleLoginRequired(anonymous as never, VALID_REQUIRED as never);
      expect(mockRedis.publish).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('T-HLM2 发布形状', () => {
    it('required 用 socket 注入 controllerId/userId 并带全部字段', async () => {
      await manager.handleLoginRequired(socket as never, {
        ...VALID_REQUIRED,
        account: 'managed:kimi-code',
      });

      const [event] = published('harness:login:required');
      expect(event).toMatchObject({
        requestId: 'req-1',
        controllerId: 'ctrl-1',
        userId: 'user-1',
        serverType: 'kimi_code',
        trigger: 'probe-options',
        url: VALID_REQUIRED.url,
        userCode: 'ABCD-1234',
        expiresInSeconds: 1800,
      });
      expect(typeof event.receivedAt).toBe('string');
      expect(Number.isNaN(Date.parse(event.receivedAt as string))).toBe(false);
      // account 仅日志口径，不进入 required 载荷
      expect(event.account).toBeUndefined();
    });

    it('expiresInSeconds 缺省为 1800', async () => {
      const { expiresInSeconds: _ignored, ...rest } = VALID_REQUIRED;
      await manager.handleLoginRequired(socket as never, rest as never);
      expect(published('harness:login:required')[0].expiresInSeconds).toBe(1800);
    });
  });

  describe('T-HLM3 required 幂等', () => {
    it('同 controller 不同 requestId 只发布一次并告警', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await manager.handleLoginRequired(socket as never, VALID_REQUIRED as never);
      await manager.handleLoginRequired(socket as never, { ...VALID_REQUIRED, requestId: 'req-2' });

      expect(published('harness:login:required')).toHaveLength(1);
      expect(registry.pendingFor('ctrl-1')?.requestId).toBe('req-1');
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('T-HLM4/T-HLM5 注册表与缓存失效', () => {
    it('required 后注册表命中，succeeded 后清除并删缓存', async () => {
      await manager.handleLoginRequired(socket as never, VALID_REQUIRED as never);
      expect(registry.pendingFor('ctrl-1')?.requestId).toBe('req-1');
      expect(registry.pendingFor('ctrl-1')?.deadlineMs).toBeGreaterThan(Date.now());

      await manager.handleLoginSucceeded(socket as never, { requestId: 'req-1', account: 'managed:kimi-code' });

      expect(registry.pendingFor('ctrl-1')).toBeUndefined();
      expect(manager.getPendingCount()).toBe(0);
      expect(mockRedis.del).toHaveBeenCalledWith('acp:options:ctrl-1:kimi_code');
      expect(published('harness:login:resolved')).toEqual([
        {
          requestId: 'req-1',
          controllerId: 'ctrl-1',
          userId: 'user-1',
          result: 'succeeded',
          account: 'managed:kimi-code',
        },
      ]);
    });

    it('failed(timeout) 映射为 expired 且不删缓存', async () => {
      await manager.handleLoginRequired(socket as never, VALID_REQUIRED as never);
      await manager.handleLoginFailed(socket as never, { requestId: 'req-1', reason: 'timeout' });

      expect(mockRedis.del).not.toHaveBeenCalled();
      expect(registry.pendingFor('ctrl-1')).toBeUndefined();
      expect(published('harness:login:resolved')[0]).toMatchObject({ result: 'expired' });
    });

    it('failed(cancelled/error) 映射为 cancelled/failed', async () => {
      await manager.handleLoginRequired(socket as never, VALID_REQUIRED as never);
      await manager.handleLoginFailed(socket as never, { requestId: 'req-1', reason: 'cancelled' });
      expect(published('harness:login:resolved')[0]).toMatchObject({ result: 'cancelled' });

      await manager.handleLoginRequired(socket as never, { ...VALID_REQUIRED, requestId: 'req-3' });
      await manager.handleLoginFailed(socket as never, { requestId: 'req-3', reason: 'error', error: 'boom' });
      expect(published('harness:login:resolved')[1]).toMatchObject({ result: 'failed', error: 'boom' });
    });

    it('非属主 socket 上报 succeeded/failed 不清理、不发布（P2-4）', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await manager.handleLoginRequired(socket as never, VALID_REQUIRED as never);
      const intruder = createMockSocket('socket-other');

      await manager.handleLoginSucceeded(intruder as never, { requestId: 'req-1' });
      await manager.handleLoginFailed(intruder as never, { requestId: 'req-1', reason: 'cancelled' });

      expect(manager.getPendingCount()).toBe(1);
      expect(registry.pendingFor('ctrl-1')?.requestId).toBe('req-1');
      expect(published('harness:login:resolved')).toEqual([]);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('未知 requestId / 未知 reason 丢弃且不发布', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await manager.handleLoginSucceeded(socket as never, { requestId: 'nope' });
      await manager.handleLoginRequired(socket as never, VALID_REQUIRED as never);
      await manager.handleLoginFailed(socket as never, { requestId: 'req-1', reason: 'weird' as never });

      expect(published('harness:login:resolved')).toHaveLength(0);
      expect(registry.pendingFor('ctrl-1')?.requestId).toBe('req-1');
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('T-HLM6 取消下发', () => {
    it('cancel 定向 emit 到发起 socket', async () => {
      await manager.handleLoginRequired(socket as never, VALID_REQUIRED as never);
      manager.handleCancel({ requestId: 'req-1' });

      expect(socket.emit).toHaveBeenCalledWith('harness:login:cancel', { requestId: 'req-1' });
      // 取消不自行清注册表：等 controller 上抛 failed(cancelled) 收敛
      expect(registry.pendingFor('ctrl-1')?.requestId).toBe('req-1');
    });

    it('socket 不在时丢弃并告警', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await manager.handleLoginRequired(socket as never, VALID_REQUIRED as never);
      io.sockets.sockets.delete(socket.id);

      manager.handleCancel({ requestId: 'req-1' });
      expect(socket.emit).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('未知 requestId 丢弃并告警', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      manager.handleCancel({ requestId: 'nope' });
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('T-HLM7 断开收敛', () => {
    it('disconnect 发布 resolved failed 并清注册表', async () => {
      await manager.handleLoginRequired(socket as never, VALID_REQUIRED as never);
      manager.clearForSocket(socket.id);

      expect(registry.pendingFor('ctrl-1')).toBeUndefined();
      expect(manager.getPendingCount()).toBe(0);

      await vi.waitFor(() => {
        expect(published('harness:login:resolved')).toEqual([
          {
            requestId: 'req-1',
            controllerId: 'ctrl-1',
            userId: 'user-1',
            result: 'failed',
            error: 'controller disconnected',
          },
        ]);
      });
    });

    it('其它 socket 的登录不受影响', async () => {
      await manager.handleLoginRequired(socket as never, VALID_REQUIRED as never);
      manager.clearForSocket('other-socket');
      expect(registry.pendingFor('ctrl-1')?.requestId).toBe('req-1');
    });
  });
});
