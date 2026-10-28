import { User } from '../models/user.js';
import { verifyToken } from '../services/auth.js';

export interface AuthenticatedUser {
  id: string;
  tenantId: string;
  name: string;
}

/**
 * JWT 校验后直读用户：一次 findById 同时取得身份与租户归属（tenantId），零额外查询。
 * 一期 personal 租户 `_id` 复用 userId，历史/半迁移行缺失 tenantId 时回退为 userId。
 */
export async function authenticateUser(request: Request): Promise<AuthenticatedUser | null> {
  const header = request.headers.get('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }

  const token = header.slice(7);
  if (!token) {
    return null;
  }

  try {
    const payload = verifyToken(token);
    const user = await User.findById(payload.userId).select('tenantId name');
    if (!user) {
      return null;
    }
    const id = user._id.toString();
    return {
      id,
      tenantId: user.tenantId ? user.tenantId.toString() : id,
      name: user.name ?? '',
    };
  } catch {
    return null;
  }
}
