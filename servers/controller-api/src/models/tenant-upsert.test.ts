import { describe, it, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { Controller } from './controller.js';
import { McpServer } from './mcp-server.js';

afterEach(() => vi.restoreAllMocks());

/**
 * controller-api 共写集合的 tenantId 双写（T-ISO 等价层级）：
 * 注册 upsert 使用「顶层 userId + $set（timestamps）」形态，插件必须识别并落 tenantId。
 */
describe('controller-api tenantId dual-write', () => {
  it.each([
    ['Controller', Controller],
    ['McpServer', McpServer],
  ] as const)('%s upsert writes tenantId=userId', async (_name, model) => {
    const spy = vi
      .spyOn(model.collection, 'findOneAndUpdate')
      .mockResolvedValue(null as never);
    const userId = new mongoose.Types.ObjectId();

    const queryable = model as unknown as {
      findOneAndUpdate: (...args: unknown[]) => Promise<unknown>;
    };
    await queryable.findOneAndUpdate(
      { userId },
      { userId, hostname: 'h', status: 'online', $setOnInsert: { name: 'h' } } as never,
      { upsert: true, returnDocument: 'after' },
    );

    const update = spy.mock.calls[0][1] as Record<string, unknown>;
    const set = update.$set as Record<string, unknown>;
    expect(String(set.userId)).toBe(String(userId));
    expect(String(set.tenantId)).toBe(String(userId));
  });

  it('declares tenantId on all five co-written models', async () => {
    const { ControllerKey } = await import('./controller-key.js');
    const { Session } = await import('./session.js');
    const { McpSessionEndpoint } = await import('./mcp-session-endpoint.js');
    for (const model of [Controller, ControllerKey, Session, McpServer, McpSessionEndpoint]) {
      expect(model.schema.path('userId')).toBeTruthy();
      expect(model.schema.path('tenantId')).toBeTruthy();
    }
  });
});
