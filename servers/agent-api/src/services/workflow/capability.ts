import { Controller } from '../../models/controller.js';
import { getRedisClient } from '../../middleware/redis.js';
import { actorFilter } from '../workspace-context.js';

/**
 * 校验 controller 归属并读取其 ACP capabilities（Redis `acp:capability:<controllerId>`）
 * 缓存缺失时通过 Redis 发送 acp:check 命令回源（复用 session.ts 协议路径），
 * controller-api 的 acpCapabilityDetector.detectCapabilities 检测后自动回写缓存（TTL 3600）。
 * 轮询最终缓存 key `acp:capability:<controllerId>` 而非中间结果，确保单一写入源。
 */
export async function getAvailableServerTypes(controllerId: string, userId: string): Promise<string[]> {
  const controller = await Controller.findOne({ _id: controllerId, ...actorFilter(userId) }).lean();
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
    // 控制器在线：发送 acp:check 命令触发 controller-api 探测并回写缓存
    // acp:check 超时 10s，轮询上限 12s（含余量）
    try {
      await redis.publish(
        'session:command',
        JSON.stringify({
          type: 'acp:check',
          requestId: `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          controllerId,
        }),
      );
      // 轮询最终缓存 key：acpCapabilityDetector 探测完成后会写入此 key
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const result = await redis.get(`acp:capability:${controllerId}`);
        if (result) {
          const parsed = JSON.parse(result) as { servers?: { type: string; available: boolean }[] };
          return (parsed.servers ?? []).filter((s) => s.available).map((s) => s.type);
        }
      }
    } catch (err) {
      console.error(`回源查询控制器能力失败（${controllerId}）：`, err);
    }
  }

  throw new Error(`控制器「${controller.name || controllerId}」的 Agent 能力信息不可用（可能离线），请确认控制器在线后重试`);
}
