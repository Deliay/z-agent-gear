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
    const admin = await AdminUser.findById(payload.adminId).select('username mustChangePassword');
    if (!admin) {
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
