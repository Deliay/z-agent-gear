import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to ensure mock objects are available when vi.mock is hoisted
const { mockRedis, mockController } = vi.hoisted(() => ({
  mockRedis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    publish: vi.fn(),
  },
  mockController: {
    _id: { toString: () => 'ctrl-1' },
    userId: { toString: () => 'user-1' },
    name: '测试控制器',
    status: 'online',
  },
}));

vi.mock('../../models/controller.js', () => ({
  Controller: {
    findOne: vi.fn().mockReturnValue({ lean: () => mockController }),
  },
}));

vi.mock('../../middleware/redis.js', () => ({
  getRedisClient: vi.fn().mockReturnValue(mockRedis),
}));

// Import after mocks
import { getAvailableServerTypes } from './capability.js';
import { Controller } from '../../models/controller.js';
import { getRedisClient } from '../../middleware/redis.js';

describe('getAvailableServerTypes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Controller.findOne).mockReturnValue({ lean: () => mockController } as any);
    vi.mocked(getRedisClient).mockReturnValue(mockRedis as any);
  });

  it('缓存存在时直接返回能力列表', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({
      servers: [
        { type: 'opencode', available: true },
        { type: 'cursor', available: false },
      ],
      checkedAt: new Date().toISOString(),
    }));

    const result = await getAvailableServerTypes('ctrl-1', 'user-1');
    expect(result).toEqual(['opencode']);
    expect(mockRedis.publish).not.toHaveBeenCalled();
  });

  it('缓存缺失+控制器在线时回源成功（acp:check 路径）', async () => {
    mockRedis.get
      .mockResolvedValueOnce(null) // 首次查 acp:capability:ctrl-1
      .mockResolvedValueOnce(null) // 第1秒轮询
      .mockResolvedValueOnce(JSON.stringify({ // 第2秒轮询：回写成功
        servers: [{ type: 'opencode', available: true }],
        checkedAt: new Date().toISOString(),
      }));
    
    const result = await getAvailableServerTypes('ctrl-1', 'user-1');
    expect(result).toEqual(['opencode']);
    expect(mockRedis.publish).toHaveBeenCalledWith('session:command', expect.stringContaining('"type":"acp:check"'));
    // 不再写入缓存（由 controller-api 统一回写）
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('缓存缺失+控制器离线时直接抛错', async () => {
    vi.mocked(Controller.findOne).mockReturnValue({
      lean: () => ({ ...mockController, status: 'offline' }),
    } as any);
    mockRedis.get.mockResolvedValueOnce(null);
    
    await expect(getAvailableServerTypes('ctrl-1', 'user-1')).rejects.toThrow('Agent 能力信息不可用');
    expect(mockRedis.publish).not.toHaveBeenCalled();
  });

  it('回源超时时抛错', async () => {
    mockRedis.get.mockResolvedValue(null); // 永远返回 null
    
    await expect(getAvailableServerTypes('ctrl-1', 'user-1')).rejects.toThrow('Agent 能力信息不可用');
  }, 15000);
});
