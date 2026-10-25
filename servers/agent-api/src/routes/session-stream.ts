import { Router, type Request, type Response } from 'express';
import { User } from '../models/user.js';
import { verifyToken } from '../services/auth.js';
import { sessionSSEService } from '../services/session-sse.js';

const router = Router();

async function authenticateExpressUser(req: Request): Promise<{ id: string; username: string } | null> {
  // Support both Authorization header and ?token= query param (for EventSource which cannot set headers)
  let token: string | undefined;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    token = header.slice(7);
  } else if (req.query.token && typeof req.query.token === 'string') {
    token = req.query.token;
  }

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

router.get('/session/:id/stream', async (req: Request, res: Response) => {
  const currentUser = await authenticateExpressUser(req);
  if (!currentUser) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const sessionId = req.params.id as string;
  await sessionSSEService.addConnection(sessionId, currentUser.id, res);
});

// 用户级事件流（不绑定会话）：登录引导等全局事件即时下发；HOME_OVERVIEW 轮询仍为兜底
router.get('/user/stream', async (req: Request, res: Response) => {
  const currentUser = await authenticateExpressUser(req);
  if (!currentUser) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  sessionSSEService.addUserConnection(currentUser.id, res);
});

export const sessionStreamRouter = router;