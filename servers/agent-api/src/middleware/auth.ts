import { User } from '../models/user.js';
import { verifyToken } from '../services/auth.js';

export async function authenticateUser(request: Request) {
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
    const user = await User.findById(payload.userId).select('username');
    if (!user) {
      return null;
    }
    return { id: user._id.toString(), username: user.username };
  } catch {
    return null;
  }
}
