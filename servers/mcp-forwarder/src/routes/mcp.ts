import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { forwardToProxy } from '../services/controller-client.js';

interface McpRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: {
    serverName?: string;
    [key: string]: unknown;
  };
}

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
      const request = req.body as McpRequest;
      
      if (!request.jsonrpc || !request.method) {
        res.status(400).json({ error: 'Invalid MCP request: missing jsonrpc or method' });
        return;
      }

      const serverName = request.params?.serverName || session.serverNames[0];
      if (!serverName) {
        res.status(400).json({ error: 'No server name specified' });
        return;
      }

      const result = await forwardToProxy(serverName, request);
      res.json(result);
    } catch (err: any) {
      res.status(502).json({ error: err.message });
    }
  });

  return router;
}
