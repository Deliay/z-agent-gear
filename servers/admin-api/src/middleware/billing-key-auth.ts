import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { CloudHost } from '../models/cloud-host.js';
import { apiKeyService, type VerifiedApiKey } from '../services/billing/api-key-service.js';
import { isCloudHostOwnedBy } from '../services/billing/cloud-host-ownership.js';
import { clientIpFromNode } from './client-ip.js';

export interface BillingRequest extends Request {
  billing?: VerifiedApiKey;
}

const AUTH_FAILURE_LIMIT = 20;
const AUTH_FAILURE_WINDOW_MS = 60_000;
const authFailures = new Map<string, { count: number; resetAt: number }>();

/** C5：401 路径节流（按来源 IP），避免无限 401 触发 bcrypt CPU/DB 消耗。 */
function authThrottled(key: string): boolean {
  const now = Date.now();
  if (authFailures.size > 10_000) {
    for (const [ip, bucket] of authFailures) {
      if (bucket.resetAt <= now) authFailures.delete(ip);
    }
  }
  const bucket = authFailures.get(key);
  return !!bucket && bucket.resetAt > now && bucket.count >= AUTH_FAILURE_LIMIT;
}

function recordAuthFailure(key: string): void {
  const now = Date.now();
  const bucket = authFailures.get(key);
  if (!bucket || bucket.resetAt <= now) {
    authFailures.set(key, { count: 1, resetAt: now + AUTH_FAILURE_WINDOW_MS });
    return;
  }
  bucket.count += 1;
}

function clearAuthFailures(key: string): void {
  authFailures.delete(key);
}

export function openAiError(
  res: Response,
  status: number,
  error: { type: string; code: string; message: string },
): void {
  res.status(status).json({ error });
}

function rejectInvalidApiKey(res: Response, source: string, message: string): void {
  if (source) recordAuthFailure(source);
  openAiError(res, 401, {
    type: 'invalid_request_error',
    code: 'invalid_api_key',
    message,
  });
}

/**
 * B9/A16：`scope=cloud_host` 的 Key 必须同时满足：
 * - 有 `cloudHostId`，且历史遗留的 `expiresAt`（若存在）未到期（新 Key 不再写有效期，随容器回收）；
 * - 云电脑存在、未软删除、状态为 `RUNNING`（STARTING 创建窗口也拒绝：初始化阶段不调模型网关）。
 * 账号 Key 维持原行为（不做宿主校验）。
 */
async function isCloudHostKeyUsable(verified: VerifiedApiKey): Promise<boolean> {
  if (verified.scope !== 'cloud_host') return true;
  if (!verified.cloudHostId || !mongoose.isValidObjectId(verified.cloudHostId)) return false;
  // 云电脑 Key 的失效开关是容器状态而非时间；仅对历史遗留的 expiresAt 做防御性校验。
  if (verified.expiresAt && verified.expiresAt.getTime() <= Date.now()) return false;
  const host = await CloudHost.findById(verified.cloudHostId)
    .select({ status: 1, deletedAt: 1, userId: 1, tenantId: 1 })
    .lean<{
      status?: string;
      deletedAt?: Date | null;
      userId?: unknown;
      tenantId?: unknown;
    } | null>();
  if (!host || host.deletedAt || host.status !== 'RUNNING') return false;
  // 纵深防御：运行 Key 的属主必须与云电脑属主一致（防止跨用户 Key 复用）。
  // 口径与铸造端一致：tenant 比较 host.tenantId（ownerId=tenantId），
  // 历史行缺 tenantId 时回退 userId；admin_user 保留管理豁免。
  return isCloudHostOwnedBy(host, verified.ownerType, verified.ownerId);
}

/** `Authorization: Bearer zag_sk_<hex>` → 校验 API Key 并注入 `billing`。 */
export async function billingKeyAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // R4：使用受信代理语义解析客户端 IP（`req.ip` 在 LB/NAT 后为共享出口 IP，会误伤有效 Key）。
  // 无法确定对端时返回空串 → 不设桶（对未知来源不聚合限流，避免锁死全站）。
  const source = clientIpFromNode(req as unknown as { socket?: { remoteAddress?: string | null } | null; headers?: Record<string, string | string[] | undefined> });
  if (source && authThrottled(source)) {
    openAiError(res, 429, {
      type: 'rate_limit_exceeded',
      code: 'rate_limit_exceeded',
      message: '请求过于频繁，请稍后重试',
    });
    return;
  }
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    rejectInvalidApiKey(res, source, '缺少 API Key');
    return;
  }
  const secret = header.slice(7).trim();
  const verified = await apiKeyService.verify(secret);
  if (!verified) {
    rejectInvalidApiKey(res, source, 'API Key 无效或已吊销');
    return;
  }
  // B9：云电脑 Key 实时失效（过期 / 宿主不存在 / 已删除 / 非 RUNNING）。
  if (!(await isCloudHostKeyUsable(verified))) {
    rejectInvalidApiKey(res, source, 'API Key 无效或已失效');
    return;
  }
  if (source) clearAuthFailures(source);
  (req as BillingRequest).billing = verified;
  next();
}
