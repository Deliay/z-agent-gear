import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/index.js', () => ({
  env: {
    port: 3002,
    jwtSecret: 'test-secret',
    controllerApiUrl: 'http://localhost:4001',
    mongodbUri: 'mongodb://localhost:27017/test',
  },
}));

vi.mock('jsonwebtoken', () => ({
  default: {
    verify: vi.fn().mockReturnValue({
      sessionId: 'session-1',
      userId: 'user-1',
      serverNames: ['github-mcp'],
    }),
  },
}));

vi.mock('../services/controller-client.js', () => ({
  forwardToProxy: vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
}));

import jwt from 'jsonwebtoken';
import { authMiddleware } from './auth.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('authMiddleware', () => {
  it('should pass with valid token', () => {
    const req = {
      headers: { authorization: 'Bearer valid-token' },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const next = vi.fn();

    authMiddleware(req as never, res as never, next);

    expect(jwt.verify).toHaveBeenCalledWith('valid-token', 'test-secret');
    expect(req.mcpSession).toEqual({
      sessionId: 'session-1',
      userId: 'user-1',
      serverNames: ['github-mcp'],
    });
    expect(next).toHaveBeenCalled();
  });

  it('should reject without authorization header', () => {
    const req = { headers: {} };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const next = vi.fn();

    authMiddleware(req as never, res as never, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('should reject with invalid token', () => {
    vi.mocked(jwt.verify).mockImplementation(() => {
      throw new Error('Invalid token');
    });

    const req = {
      headers: { authorization: 'Bearer invalid-token' },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const next = vi.fn();

    authMiddleware(req as never, res as never, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token' });
    expect(next).not.toHaveBeenCalled();
  });
});
