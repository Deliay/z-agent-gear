import { Router, Request, Response } from 'express';
import { McpProxyKeyService } from '../services/mcp-proxy-key.js';

const mcpProxyKeyService = new McpProxyKeyService();

export function createMcpProxyKeyRouter(): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response) => {
    try {
      const userId = req.headers['x-user-id'] as string;
      if (!userId) {
        return res.status(401).json({ error: 'Missing user ID' });
      }
      const keys = await mcpProxyKeyService.listKeys(userId);
      res.json(keys);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/', async (req: Request, res: Response) => {
    try {
      const userId = req.headers['x-user-id'] as string;
      if (!userId) {
        return res.status(401).json({ error: 'Missing user ID' });
      }
      const { name } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'Missing name' });
      }
      const result = await mcpProxyKeyService.createKey(userId, name);
      res.json(result);
    } catch (err: any) {
      if (err.code === 11000) {
        return res.status(409).json({ error: 'Key name already exists' });
      }
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/:id/revoke', async (req: Request, res: Response) => {
    try {
      const userId = req.headers['x-user-id'] as string;
      if (!userId) {
        return res.status(401).json({ error: 'Missing user ID' });
      }
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const result = await mcpProxyKeyService.revokeKey(userId, id);
      if (!result) {
        return res.status(404).json({ error: 'Key not found' });
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
