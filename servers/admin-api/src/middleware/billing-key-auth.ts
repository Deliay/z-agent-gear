import type { NextFunction, Request, Response } from 'express';
import { apiKeyService, type VerifiedApiKey } from '../services/billing/api-key-service.js';
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
    if (source) recordAuthFailure(source);
    openAiError(res, 401, {
      type: 'invalid_request_error',
      code: 'invalid_api_key',
      message: '缺少 API Key',
    });
    return;
  }
  const secret = header.slice(7).trim();
  const verified = await apiKeyService.verify(secret);
  if (!verified) {
    if (source) recordAuthFailure(source);
    openAiError(res, 401, {
      type: 'invalid_request_error',
      code: 'invalid_api_key',
      message: 'API Key 无效或已吊销',
    });
    return;
  }
  if (source) clearAuthFailures(source);
  (req as BillingRequest).billing = verified;
  next();
}
