import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * 内部 API 鉴权：Authorization: Bearer <INTERNAL_API_TOKEN>，
 * 使用时序安全比较，缺失/错误返回 401。
 */
export function internalAuth(expectedToken: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? '';
    const prefix = 'Bearer ';
    const provided = header.startsWith(prefix) ? header.slice(prefix.length) : '';

    if (!provided || !expectedToken || !safeEqual(provided, expectedToken)) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid internal API token' });
      return;
    }
    next();
  };
}
