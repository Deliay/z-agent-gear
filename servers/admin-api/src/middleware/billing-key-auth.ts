import type { NextFunction, Request, Response } from 'express';
import { apiKeyService, type VerifiedApiKey } from '../services/billing/api-key-service.js';

export interface BillingRequest extends Request {
  billing?: VerifiedApiKey;
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
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
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
    openAiError(res, 401, {
      type: 'invalid_request_error',
      code: 'invalid_api_key',
      message: 'API Key 无效或已吊销',
    });
    return;
  }
  (req as BillingRequest).billing = verified;
  next();
}
