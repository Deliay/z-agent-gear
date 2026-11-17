import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';

const h = vi.hoisted(() => ({
  config: { internalApiToken: 'test-internal-token-123456' },
  applyGlobalModelRefresh: vi.fn(),
}));

vi.mock('../config/index.js', () => ({ config: h.config }));
vi.mock('../services/cloud-host-model-push.js', () => ({
  applyGlobalModelRefresh: h.applyGlobalModelRefresh,
}));

import { internalModelConfigRouter } from './internal-model-config.js';

const TOKEN = 'test-internal-token-123456';

describe('POST /internal/model-config/refresh (T-CP4)', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    h.config.internalApiToken = TOKEN;
    h.applyGlobalModelRefresh.mockResolvedValue(undefined);

    const app = express();
    app.use(express.json());
    app.use('/internal/model-config', internalModelConfigRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function post(body: unknown, token: string | null = TOKEN) {
    return fetch(`${baseUrl}/internal/model-config/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it('rejects a missing or wrong bearer token with 401', async () => {
    const missing = await post({ scope: 'global' }, null);
    expect(missing.status).toBe(401);

    const wrong = await post({ scope: 'global' }, 'wrong-token');
    expect(wrong.status).toBe(401);
    expect(h.applyGlobalModelRefresh).not.toHaveBeenCalled();
  });

  it('rejects every request when INTERNAL_API_TOKEN is not configured', async () => {
    h.config.internalApiToken = '';
    const res = await post({ scope: 'global' }, '');
    expect(res.status).toBe(401);
    expect(h.applyGlobalModelRefresh).not.toHaveBeenCalled();
  });

  it('rejects a non-global or malformed body with 400 INVALID_SCOPE', async () => {
    const tenantScope = await post({ scope: 'tenant' });
    expect(tenantScope.status).toBe(400);
    expect(await tenantScope.json()).toEqual({ error: 'INVALID_SCOPE' });

    const empty = await post({});
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'INVALID_SCOPE' });

    expect(h.applyGlobalModelRefresh).not.toHaveBeenCalled();
  });

  it('accepts with 202 and schedules the global refresh asynchronously', async () => {
    const res = await post({ scope: 'global' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });

    await vi.waitFor(() => expect(h.applyGlobalModelRefresh).toHaveBeenCalledTimes(1));
  });

  it('still returns 202 when the refresh rejects', async () => {
    h.applyGlobalModelRefresh.mockRejectedValue(new Error('boom'));

    const res = await post({ scope: 'global' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    await vi.waitFor(() => expect(h.applyGlobalModelRefresh).toHaveBeenCalledTimes(1));
  });
});
