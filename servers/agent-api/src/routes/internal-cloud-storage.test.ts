import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';

const h = vi.hoisted(() => ({
  config: { internalApiToken: 'test-internal-token-123456' },
}));

vi.mock('../config/index.js', () => ({ config: h.config }));

vi.mock('../services/cloud-storage-service.js', () => ({
  cloudStorageService: {
    handleArchiveCallback: vi.fn(),
    handleUsageCallback: vi.fn(),
    handleRestoreCallback: vi.fn(),
  },
}));

import { internalCloudStorageRouter } from './internal-cloud-storage.js';
import { cloudStorageService } from '../services/cloud-storage-service.js';

const STORAGE_ID = '507f1f77bcf86cd7994390d1';

describe('internal cloud storage routes', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(cloudStorageService.handleArchiveCallback).mockResolvedValue({} as never);
    vi.mocked(cloudStorageService.handleUsageCallback).mockResolvedValue({} as never);
    vi.mocked(cloudStorageService.handleRestoreCallback).mockResolvedValue({} as never);
    const app = express();
    app.use(express.json());
    app.use('/internal/cloud-storages', internalCloudStorageRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function post(path: string, body?: unknown, token = 'test-internal-token-123456') {
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
    expect(
      (await post(`/internal/cloud-storages/${STORAGE_ID}/usage`, { usageBytes: 1 }, 'wrong'))
        .status,
    ).toBe(401);
    expect(cloudStorageService.handleUsageCallback).not.toHaveBeenCalled();
  });

  it('accepts archive callback and forwards payload (按 archiveId 幂等由 service 保证)', async () => {
    const response = await post(`/internal/cloud-storages/${STORAGE_ID}/archives`, {
      archiveId: 'a1',
      storageId: STORAGE_ID,
      cloudHostId: '507f1f77bcf86cd7994390e1',
      containerId: 'container-1',
      cloudHostName: 'my-cloud',
      fileName: 'my-cloud-20261102-153012.tar.gz2',
      path: `/archive/ws/${STORAGE_ID}/my-cloud-20261102-153012.tar.gz2`,
      status: 'SUCCEEDED',
      usageBytes: 1024,
      startedAt: '2026-11-02T15:00:00.000Z',
      finishedAt: '2026-11-02T15:10:00.000Z',
      failureReason: null,
      sourcePvcReleased: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(cloudStorageService.handleArchiveCallback).toHaveBeenCalledWith(STORAGE_ID, {
      archiveId: 'a1',
      storageId: STORAGE_ID,
      cloudHostId: '507f1f77bcf86cd7994390e1',
      containerId: 'container-1',
      cloudHostName: 'my-cloud',
      fileName: 'my-cloud-20261102-153012.tar.gz2',
      path: `/archive/ws/${STORAGE_ID}/my-cloud-20261102-153012.tar.gz2`,
      status: 'SUCCEEDED',
      usageBytes: 1024,
      startedAt: '2026-11-02T15:00:00.000Z',
      finishedAt: '2026-11-02T15:10:00.000Z',
      failureReason: null,
      sourcePvcReleased: true,
    });
  });

  it('rejects invalid archive body / unknown storage', async () => {
    expect(
      (await post(`/internal/cloud-storages/${STORAGE_ID}/archives`, { status: 'RUNNING' }))
        .status,
    ).toBe(400);
    expect(
      (
        await post(`/internal/cloud-storages/${STORAGE_ID}/archives`, {
          archiveId: 'a1',
          status: 'UNKNOWN',
        })
      ).status,
    ).toBe(400);

    vi.mocked(cloudStorageService.handleArchiveCallback).mockResolvedValue(null as never);
    expect(
      (
        await post(`/internal/cloud-storages/${STORAGE_ID}/archives`, {
          archiveId: 'a1',
          status: 'RUNNING',
        })
      ).status,
    ).toBe(404);
  });

  it('accepts usage callback with measuredAt', async () => {
    const response = await post(`/internal/cloud-storages/${STORAGE_ID}/usage`, {
      usageBytes: 2048,
      measuredAt: '2026-11-02T15:00:00.000Z',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(cloudStorageService.handleUsageCallback).toHaveBeenCalledWith(STORAGE_ID, {
      usageBytes: 2048,
      measuredAt: '2026-11-02T15:00:00.000Z',
    });
  });

  it('rejects invalid usage body / unknown storage', async () => {
    expect(
      (await post(`/internal/cloud-storages/${STORAGE_ID}/usage`, { usageBytes: -1 })).status,
    ).toBe(400);
    expect(
      (await post(`/internal/cloud-storages/${STORAGE_ID}/usage`, { usageBytes: 'x' })).status,
    ).toBe(400);

    vi.mocked(cloudStorageService.handleUsageCallback).mockResolvedValue(null as never);
    expect(
      (await post(`/internal/cloud-storages/${STORAGE_ID}/usage`, { usageBytes: 1 })).status,
    ).toBe(404);
  });

  it('accepts restore callback and forwards payload (按 operationId 幂等由 service 保证)', async () => {
    const operationId = '507f1f77bcf86cd7994390f1';
    const response = await post(`/internal/cloud-storages/${STORAGE_ID}/restores`, {
      operationId,
      storageId: STORAGE_ID,
      status: 'SUCCEEDED',
      usageBytes: 5368709120,
      startedAt: '2026-11-02T15:00:00.000Z',
      finishedAt: '2026-11-02T15:10:00.000Z',
      failureReason: null,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(cloudStorageService.handleRestoreCallback).toHaveBeenCalledWith(STORAGE_ID, {
      operationId,
      status: 'SUCCEEDED',
      usageBytes: 5368709120,
      startedAt: '2026-11-02T15:00:00.000Z',
      finishedAt: '2026-11-02T15:10:00.000Z',
      failureReason: null,
    });
  });

  it('rejects invalid restore body / unknown storage', async () => {
    expect(
      (
        await post(`/internal/cloud-storages/${STORAGE_ID}/restores`, {
          operationId: '',
          status: 'RUNNING',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(`/internal/cloud-storages/${STORAGE_ID}/restores`, {
          operationId: 'op-1',
          status: 'DONE',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(`/internal/cloud-storages/${STORAGE_ID}/restores`, {
          operationId: 'op-1',
          status: 'RUNNING',
          usageBytes: -1,
        })
      ).status,
    ).toBe(400);

    vi.mocked(cloudStorageService.handleRestoreCallback).mockResolvedValue(null as never);
    expect(
      (
        await post(`/internal/cloud-storages/${STORAGE_ID}/restores`, {
          operationId: 'op-1',
          status: 'RUNNING',
        })
      ).status,
    ).toBe(404);
  });
});
