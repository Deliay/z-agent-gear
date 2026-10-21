import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';

const h = vi.hoisted(() => ({
  config: { internalApiToken: 'test-internal-token-123456' },
}));

vi.mock('../config/index.js', () => ({ config: h.config }));

vi.mock('../services/cloud-host-service.js', () => ({
  cloudHostService: {
    findRawHost: vi.fn(),
    handleReady: vi.fn(),
    handleTerminal: vi.fn(),
  },
}));

import { internalCloudHostRouter } from './internal-cloud-host.js';
import { cloudHostService } from '../services/cloud-host-service.js';

const HOST_ID = '507f1f77bcf86cd799439011';

describe('internal cloud host routes', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    const app = express();
    app.use(express.json());
    app.use('/internal/cloud-hosts', internalCloudHostRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function post(path: string, token = 'test-internal-token-123456', body?: unknown) {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  it('rejects missing/invalid internal token', async () => {
    expect((await post(`/internal/cloud-hosts/${HOST_ID}/ready`, 'wrong')).status).toBe(401);
    expect((await post(`/internal/cloud-hosts/${HOST_ID}/ready`, '')).status).toBe(401);
  });

  it('returns 404 for unknown or non-harness hosts', async () => {
    vi.mocked(cloudHostService.findRawHost).mockResolvedValue(null);
    expect((await post(`/internal/cloud-hosts/${HOST_ID}/ready`)).status).toBe(404);

    vi.mocked(cloudHostService.findRawHost).mockResolvedValue({ harnessTypes: [] } as never);
    expect((await post(`/internal/cloud-hosts/${HOST_ID}/ready`)).status).toBe(404);
  });

  it('handles ready callback idempotently', async () => {
    vi.mocked(cloudHostService.findRawHost).mockResolvedValue({
      harnessTypes: ['OPENCODE'],
    } as never);
    vi.mocked(cloudHostService.handleReady).mockResolvedValue({ status: 'RUNNING' } as never);

    const response = await post(`/internal/cloud-hosts/${HOST_ID}/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'RUNNING' });
    expect(cloudHostService.handleReady).toHaveBeenCalledWith(HOST_ID);
  });

  it('validates terminal status', async () => {
    vi.mocked(cloudHostService.findRawHost).mockResolvedValue({
      harnessTypes: ['OPENCODE'],
    } as never);
    const response = await post(`/internal/cloud-hosts/${HOST_ID}/terminal`, undefined, {
      status: 'unknown',
    });
    expect(response.status).toBe(400);
    expect(cloudHostService.handleTerminal).not.toHaveBeenCalled();
  });

  it('forwards terminal status and reason', async () => {
    vi.mocked(cloudHostService.findRawHost).mockResolvedValue({
      harnessTypes: ['OPENCODE'],
    } as never);
    vi.mocked(cloudHostService.handleTerminal).mockResolvedValue({ status: 'FAILED' } as never);

    const response = await post(`/internal/cloud-hosts/${HOST_ID}/terminal`, undefined, {
      status: 'failed',
      reason: 'job failed',
    });
    expect(response.status).toBe(200);
    expect(cloudHostService.handleTerminal).toHaveBeenCalledWith(HOST_ID, {
      status: 'failed',
      reason: 'job failed',
    });
  });
});
