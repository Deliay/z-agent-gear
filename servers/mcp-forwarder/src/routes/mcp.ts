import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { forwardToProxy } from '../services/controller-client.js';

export function createMcpRouter(): Router {
  const router = Router();
  router.use(authMiddleware);

  router.post('/:sessionId', async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const session = req.mcpSession;

    if (!session || session.sessionId !== sessionId) {
      res.status(403).json({ error: 'Session mismatch' });
      return;
    }

    try {
      const request = req.body;
      const serverName = request.params?.serverName || session.serverNames[0];

      const result = await forwardToProxy(serverName, request);
      res.json(result);
    } catch (err: any) {
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}
