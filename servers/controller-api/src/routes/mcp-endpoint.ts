import { Router, Request, Response } from 'express';
import { mcpEndpointService } from '../services/mcp-endpoint.js';

export function createMcpEndpointRouter(): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    try {
      const { sessionId, userId, mcpServerIds } = req.body;
      if (!sessionId || !userId || !mcpServerIds) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      const result = await mcpEndpointService.createEndpoint(sessionId, userId, mcpServerIds);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:sessionId/revoke', async (req: Request, res: Response) => {
    try {
      const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
      await mcpEndpointService.revokeEndpoint(sessionId);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
