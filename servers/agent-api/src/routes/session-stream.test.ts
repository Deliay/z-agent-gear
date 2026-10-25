import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';

vi.mock('../services/auth.js', () => ({
  verifyToken: vi.fn(),
}));

vi.mock('../models/user.js', () => ({
  User: { findById: vi.fn() },
}));

vi.mock('../services/session-sse.js', () => ({
  sessionSSEService: {
    addConnection: vi.fn(),
    addUserConnection: vi.fn(),
  },
}));

import { sessionStreamRouter } from './session-stream.js';
import { verifyToken } from '../services/auth.js';
import { User } from '../models/user.js';
import { sessionSSEService } from '../services/session-sse.js';

function mockUserLookup() {
  vi.mocked(User.findById).mockReturnValue({
    select: vi.fn().mockResolvedValue({ _id: 'user-1', username: 'u1' }),
  } as never);
}

describe('GET /api/user/stream', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const app = express();
    app.use('/api', sessionStreamRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('T-HS2: 未认证返回 401 且不建立连接', async () => {
    const res = await fetch(`${baseUrl}/api/user/stream`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not authenticated' });
    expect(sessionSSEService.addUserConnection).not.toHaveBeenCalled();
  });

  it('T-HS2b: ?token= 鉴权通过后建立用户级连接', async () => {
    vi.mocked(verifyToken).mockReturnValue({ userId: 'user-1' } as never);
    mockUserLookup();
    vi.mocked(sessionSSEService.addUserConnection).mockImplementation(((userId: string, res: import('express').Response) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end();
    }) as never);

    const res = await fetch(`${baseUrl}/api/user/stream?token=good-token`);
    expect(res.status).toBe(200);
    expect(verifyToken).toHaveBeenCalledWith('good-token');
    expect(sessionSSEService.addUserConnection).toHaveBeenCalledWith('user-1', expect.anything());
    await res.body?.cancel();
  });
});
