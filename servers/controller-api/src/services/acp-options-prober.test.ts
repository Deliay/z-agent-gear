import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { AcpOptionsProber } from './acp-options-prober.js';
import { getRedisClient } from '../middleware/redis.js';

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
};

function createMockSocket() {
  return { id: 'socket-123', emit: vi.fn() };
}

describe('AcpOptionsProber', () => {
  let prober: AcpOptionsProber;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
    mockRedis.get.mockResolvedValue(null);
    prober = new AcpOptionsProber();
  });

  it('缓存命中时直接返回，不再向 controller 发探测', async () => {
    const cached = {
      modes: [{ id: 'code', name: 'Code' }],
      models: [{ id: 'gpt-5', name: 'GPT-5' }],
      currentModeId: 'code',
      currentModelId: 'gpt-5',
      probedAt: '2026-08-08T00:00:00Z',
    };
    mockRedis.get.mockResolvedValue(JSON.stringify(cached));
    const socket = createMockSocket();

    const result = await prober.probeOptions(socket as never, 'ctrl-1', 'opencode');

    expect(result).toEqual(cached);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('缓存未命中时发送 acp:probe-options，成功后写缓存并返回', async () => {
    const socket = createMockSocket();
    const promise = prober.probeOptions(socket as never, 'ctrl-1', 'opencode');

    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith('acp:probe-options', expect.objectContaining({
        serverType: 'opencode',
      }));
    });
    const requestId = (socket.emit.mock.calls[0][1] as { requestId: string }).requestId;

    await prober.handleProbeResult('ctrl-1', {
      requestId,
      serverType: 'opencode',
      success: true,
      modes: [{ id: 'code', name: 'Code' }],
      availableModels: [{ id: 'gpt-5', name: 'GPT-5', provider: 'openai' }],
      currentModeId: 'code',
      currentModelId: 'gpt-5',
    });

    const result = await promise;
    expect(result.modes).toEqual([{ id: 'code', name: 'Code' }]);
    expect(result.models).toEqual([{ id: 'gpt-5', name: 'GPT-5', provider: 'openai' }]);
    expect(result.currentModeId).toBe('code');
    expect(result.currentModelId).toBe('gpt-5');
    expect(result.probedAt).toBeTruthy();

    // 成功结果缓存 1h
    expect(mockRedis.set).toHaveBeenCalledWith(
      'acp:options:ctrl-1:opencode',
      expect.any(String),
      'EX',
      3600,
    );
  });

  it('探测失败时返回空选项并以短 TTL 缓存（agent-api 可尽快拿到结果）', async () => {
    const socket = createMockSocket();
    const promise = prober.probeOptions(socket as never, 'ctrl-1', 'claude_code');
    await vi.waitFor(() => {
      expect(socket.emit).toHaveBeenCalledWith('acp:probe-options', expect.anything());
    });
    const requestId = (socket.emit.mock.calls[0][1] as { requestId: string }).requestId;

    await prober.handleProbeResult('ctrl-1', {
      requestId,
      serverType: 'claude_code',
      success: false,
      error: 'auth required',
    });

    const result = await promise;
    expect(result).toEqual({
      modes: [],
      models: [],
      currentModeId: null,
      currentModelId: null,
      probedAt: null,
    });
    expect(mockRedis.set).toHaveBeenCalledWith(
      'acp:options:ctrl-1:claude_code',
      expect.any(String),
      'EX',
      60,
    );
  });

  it('未知 requestId 的探测结果静默忽略', async () => {
    await expect(
      prober.handleProbeResult('ctrl-1', {
        requestId: 'unknown',
        serverType: 'opencode',
        success: true,
      }),
    ).resolves.toBeUndefined();
    expect(mockRedis.set).not.toHaveBeenCalled();
  });
});
