import { Controller } from '../../models/controller.js';
import { getRedisClient } from '../../middleware/redis.js';

/**
 * 校验 controller 归属并读取其 ACP capabilities（Redis `acp:capability:<controllerId>`）
 * 缓存缺失时通过 Redis 发送 acp:capability:query 命令回源（controller-api 处理）
 * 回写缓存 shape 统一为 { servers, checkedAt }（与 acpCapabilityDetector.detectCapabilities 一致）
 */
export async function getAvailableServerTypes(controllerId: string, userId: string): Promise<string[]> {
  const controller = await Controller.findOne({ _id: controllerId, userId }).lean();
  if (!controller) {
    throw new Error('控制器不存在或不属于当前用户');
  }
  const redis = getRedisClient();
  const cached = await redis.get(`acp:capability:${controllerId}`);
  if (cached) {
    const parsed = JSON.parse(cached) as { servers?: { type: string; available: boolean }[] };
    return (parsed.servers ?? []).filter((s) => s.available).map((s) => s.type);
  }

  // 缓存缺失：回源查询控制器状态
  if (controller.status === 'online') {
    // 控制器在线：通过控制器通道主动拉取能力并回热缓存（短超时）
    try {
      const requestId = `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await redis.publish(
        'session:command',
        JSON.stringify({
          type: 'acp:capability:query',
          requestId,
          controllerId,
        }),
      );
      // 等待控制器响应（最多 5 秒）
      for (let i = 0; i < 5; i++) {
        const result = await redis.get(`acp:capability:query:${requestId}`);
        if (result) {
          const parsed = JSON.parse(result);
          await redis.del(`acp:capability:query:${requestId}`);
          
          // 检查回源是否成功
          if (!parsed.success) {
            console.error(`回源查询控制器能力失败（${controllerId}）：`, parsed.error);
            throw new Error(`控制器「${controller.name || controllerId}」的 Agent 能力信息不可用（可能离线），请确认控制器在线后重试`);
          }
          
          // 回写缓存，shape 统一为 { servers, checkedAt }
          const servers = parsed.servers ?? [];
          await redis.set(
            `acp:capability:${controllerId}`,
            JSON.stringify({
              servers,
              checkedAt: new Date().toISOString(),
            }),
            'EX',
            300,
          );
          return servers.filter((s: { available: boolean }) => s.available).map((s: { type: string }) => s.type);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      // 超时：继续报错
    } catch (err) {
      console.error(`回源查询控制器能力失败（${controllerId}）：`, err);
      // 如果是我们的错误，直接抛出；否则抛出通用错误
      if (err instanceof Error && err.message.includes('Agent 能力信息不可用')) {
        throw err;
      }
    }
  }

  throw new Error(`控制器「${controller.name || controllerId}」的 Agent 能力信息不可用（可能离线），请确认控制器在线后重试`);
}
