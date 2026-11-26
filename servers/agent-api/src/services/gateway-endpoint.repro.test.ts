import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 调查阶段最小复现（Issue #565 / 网关功能更新）
 *
 * 目标断言（期望行为，当前实现应为 RED）：
 * 1. `gatewayService.create` 创建端点后应返回可直接使用的外网 endpoint；
 * 2. 平台 MCP 应存在网关工具 handler（`agent-gateway-tools`）。
 *
 * 说明：本文件是调查报告的可执行证据，不是最终回归用例；
 * 实现落地后由修复节点将其转正/改写为正式测试。
 */

vi.mock('../models/gateway.js', () => ({
  Gateway: {
    find: vi.fn(),
    findOne: vi.fn(),
    findOneAndDelete: vi.fn(),
    countDocuments: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('../models/controller.js', () => ({
  Controller: {
    findOne: vi.fn(),
  },
}));

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

import { gatewayService } from './gateway.js';
import { Gateway } from '../models/gateway.js';
import { Controller } from '../models/controller.js';
import { getRedisClient } from '../middleware/redis.js';

const mockRedis = { publish: vi.fn().mockResolvedValue(1) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRedisClient).mockReturnValue(mockRedis as never);
});

describe('Issue #565 最小复现：网关创建端点返回 endpoint', () => {
  it('T-GMCP-REPRO-1: create 返回值应包含具体 endpoint', async () => {
    const now = new Date();
    vi.mocked(Controller.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'ctrl1', status: 'online' }),
    } as never);
    vi.mocked(Gateway.countDocuments).mockResolvedValue(0);
    vi.mocked(Gateway.findOne).mockResolvedValue(null);
    vi.mocked(Gateway.create).mockResolvedValue({
      toObject: () => ({
        _id: { toString: () => 'gw1' },
        controllerId: { toString: () => 'ctrl1' },
        name: 'my-service',
        port: 3000,
        status: 'active',
        createdAt: now,
      }),
    } as never);

    const result = (await gatewayService.create('ctrl1', 'user1', 'my-service', 3000, 5)) as Record<
      string,
      unknown
    >;

    // 期望：返回外网可访问的具体 endpoint（当前 mapGateway 不返回该字段）
    expect(result.endpoint).toBe('http://localhost:10001/api/gateway/ctrl1/my-service/');
  });

  it('T-GMCP-REPRO-2: 平台 MCP 网关工具 handler 应存在', async () => {
    // 用变量路径动态导入：模块当前不存在时既不产生 TS 编译错误，又能让用例 RED。
    const modulePath = './gateway-tools.js';
    const mod = await import(/* @vite-ignore */ modulePath).catch(() => null);

    // 期望：存在 agent-api 平台 MCP 网关工具 handler（当前仓库无此模块）
    expect(mod, '未找到平台 MCP 网关工具 handler（agent-gateway-tools）').not.toBeNull();
  });
});
