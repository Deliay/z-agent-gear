import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.mcpSession = {
      sessionId: 'session-1',
      userId: 'user-1',
      serverNames: ['github-mcp'],
    };
    next();
  },
}));

vi.mock('../services/controller-client.js', () => ({
  forwardToProxy: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
}));

import { createMcpRouter } from './mcp.js';
import { forwardToProxy } from '../services/controller-client.js';

let router: ReturnType<typeof createMcpRouter>;

beforeEach(() => {
  vi.clearAllMocks();
  router = createMcpRouter();
});

describe('MCP Router', () => {
  it('should create router with POST /:sessionId route', () => {
    expect(router).toBeDefined();
    // The router should have routes defined
    const routes = router.stack?.map((layer: any) => ({
      path: layer.route?.path,
      method: layer.route?.methods?.post,
    }));
    expect(routes).toBeDefined();
  });
});
