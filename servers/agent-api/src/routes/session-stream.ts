import { Router, type Request, type Response } from 'express';
import { User } from '../models/user.js';
import { verifyToken } from '../services/auth.js';
import { sessionSSEService } from '../services/session-sse.js';

const router = Router();

async function authenticateExpressUser(req: Request): Promise<{ id: string; username: string } | null> {
  const header = req.headers.authorization;
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

router.get('/session/:id/stream', async (req: Request, res: Response) => {
  const currentUser = await authenticateExpressUser(req);
  if (!currentUser) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const sessionId = req.params.id as string;
  await sessionSSEService.addConnection(sessionId, currentUser.id, res);
});

export const sessionStreamRouter = router;