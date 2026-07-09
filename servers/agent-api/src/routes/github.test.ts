import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../middleware/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('../services/github.js', () => ({
  GitHubService: vi.fn(),
  githubService: { handleCallback: vi.fn() },
}));

import { getRedisClient } from '../middleware/redis.js';
import { handleGithubCallback } from './github.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function mockReq(query: Record<string, string | undefined>) {
  return { query } as any;
}

function mockRes() {
  const state: { url?: string } = {};
  return {
    redirect: vi.fn((url: string) => { state.url = url; }),
  } as any;
}

describe('GitHub Callback Route', () => {
  it('should redirect with error when installation_id is missing', async () => {
    const req = mockReq({ state: 'abc' });
    const res = mockRes();

    await handleGithubCallback(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('binding=error&message=missing_params'),
    );
  });

  it('should redirect with error when state is missing', async () => {
    const req = mockReq({ installation_id: '123' });
    const res = mockRes();

    await handleGithubCallback(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('binding=error&message=missing_params'),
    );
  });

  it('should redirect with error when state is invalid in Redis', async () => {
    const mockRedis = { get: vi.fn().mockResolvedValue(null), del: vi.fn() };
    vi.mocked(getRedisClient).mockResolvedValue(mockRedis as any);

    const req = mockReq({ installation_id: '123', state: 'invalid-state' });
    const res = mockRes();

    await handleGithubCallback(req, res);

    expect(mockRedis.get).toHaveBeenCalledWith('github:oauth:state:invalid-state');
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('binding=error&message=invalid_state'),
    );
  });

  it('should process callback and redirect with success', async () => {
    const mockRedis = { get: vi.fn().mockResolvedValue('user1'), del: vi.fn() };
    vi.mocked(getRedisClient).mockResolvedValue(mockRedis as any);

    const req = mockReq({ installation_id: '42', state: 'valid-state' });
    const res = mockRes();

    await handleGithubCallback(req, res);

    expect(mockRedis.del).toHaveBeenCalledWith('github:oauth:state:valid-state');
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('binding=success'),
    );
  });

  it('should redirect with error when callback processing fails', async () => {
    const { githubService } = await import('../services/github.js');
    vi.mocked(githubService.handleCallback).mockRejectedValue(new Error('API error'));

    const mockRedis = { get: vi.fn().mockResolvedValue('user1'), del: vi.fn() };
    vi.mocked(getRedisClient).mockResolvedValue(mockRedis as any);

    const req = mockReq({ installation_id: '42', state: 'valid-state' });
    const res = mockRes();

    await handleGithubCallback(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('binding=error&message=internal_error'),
    );
  });
});
