import { Router, Request, Response } from 'express';
import { McpProxyRegistry } from '../services/mcp-proxy-registry.js';

export function createMcpProxyRouter(registry: McpProxyRegistry): Router {
  const router = Router();

  router.post('/register', async (req: Request, res: Response) => {
    try {
      const { key, hostname, command, serverName } = req.body;
      if (!key || !hostname || !command || !serverName) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      const result = await registry.register(key, hostname, command, serverName);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
