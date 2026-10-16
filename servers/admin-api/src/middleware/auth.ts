import { AdminUser } from '../models/admin-user.js';
import { verifyToken } from '../services/auth.js';

export async function authenticateAdmin(request: Request) {
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
    const admin = await AdminUser.findById(payload.adminId).select('username mustChangePassword passwordChangedAt');
    if (!admin) {
      return null;
    }
    // 改密后旧 token 失效：token 携带的 pwdAt 必须与当前 passwordChangedAt 一致（问题 6）
    const currentPwdAt = admin.passwordChangedAt ? new Date(admin.passwordChangedAt).getTime() : 0;
    if ((payload.pwdAt ?? 0) !== currentPwdAt) {
      return null;
    }
    return {
      id: admin._id.toString(),
      username: admin.username,
      mustChangePassword: admin.mustChangePassword,
    };
  } catch {
    return null;
  }
}
