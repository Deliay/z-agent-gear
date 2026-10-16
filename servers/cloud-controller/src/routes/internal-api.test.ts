import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { ContainerService } from '../services/container-service.js';
import { InMemoryK8sClient } from '../services/k8s-client.js';
import { K8sJobManager } from '../services/k8s-job-manager.js';
import { TokenService } from '../services/token-service.js';
import { InMemoryContainerRepository } from '../repositories/container-repository.js';
import { internalAuth } from '../middleware/internal-auth.js';
import { createInternalRouter } from './internal-api.js';

const INTERNAL_TOKEN = 'test-internal-token';

let httpServer: HttpServer;
let baseUrl: string;

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${INTERNAL_TOKEN}`, ...extra };
}

beforeAll(async () => {
  const repo = new InMemoryContainerRepository();
  const client = new InMemoryK8sClient();
  const tokenService = new TokenService(repo);
  const jobManager = new K8sJobManager(client, {
    namespace: 'zag-workers',
    image: 'zero-tools/zag-worker:latest',
    runtimeClassName: 'sysbox-runc',
    publicWsEndpoint: 'cloud.example.com:4003',
  });
  const service = new ContainerService(repo, tokenService, jobManager, {
    namespace: 'zag-workers',
    image: 'zero-tools/zag-worker:latest',
    connectTimeoutMs: 300000,
    shutdownGraceMs: 0,
  });

  const app = express();
  app.use(express.json());
  app.use('/internal', internalAuth(INTERNAL_TOKEN), createInternalRouter(service));
  httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('internal management API', () => {
  it('T-R1: GET/POST/DELETE conform to the contract (exit code + body shape)', async () => {
    const empty = await fetch(`${baseUrl}/internal/containers`, { headers: authHeaders() });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    const created = await fetch(`${baseUrl}/internal/containers`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ purpose: 'idle' }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        'connectedAt',
        'createdAt',
        'exitReason',
        'exitedAt',
        'id',
        'image',
        'name',
        'namespace',
        'purpose',
        'refId',
        'status',
        'userId',
      ].sort(),
    );
    expect(body.status).toBe('connecting');
    expect(body.purpose).toBe('idle');
    expect(body.refId).toBeNull();

    const list = await fetch(`${baseUrl}/internal/containers`, { headers: authHeaders() });
    expect((await list.json()).length).toBeGreaterThanOrEqual(1);

    const destroyed = await fetch(`${baseUrl}/internal/containers/${body.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(destroyed.status).toBe(200);
    // 契约 A.2.3：响应透出 deletedJob（问题 50）
    expect(await destroyed.json()).toEqual({ success: true, deletedJob: true });
  });

  it('T-R2: missing or invalid bearer token -> 401', async () => {
    const missing = await fetch(`${baseUrl}/internal/containers`);
    expect(missing.status).toBe(401);

    const wrong = await fetch(`${baseUrl}/internal/containers`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(wrong.status).toBe(401);
  });

  it('T-R3: non-idle purpose is rejected with a clear message', async () => {
    const res = await fetch(`${baseUrl}/internal/containers`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ purpose: 'workflow' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('该任务类型暂未开放');
  });

  it('T-R4: deleting an unknown container -> 404; terminal container -> idempotent success', async () => {
    const unknown = await fetch(`${baseUrl}/internal/containers/does-not-exist`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(unknown.status).toBe(404);

    const created = await fetch(`${baseUrl}/internal/containers`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ purpose: 'idle' }),
    });
    const { id } = (await created.json()) as { id: string };

    const first = await fetch(`${baseUrl}/internal/containers/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(await first.json()).toEqual({ success: true, deletedJob: true });

    const second = await fetch(`${baseUrl}/internal/containers/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(second.status).toBe(200);
    // 幂等：Job 已不存在，deletedJob 反映本次未真实删除
    expect(await second.json()).toEqual({ success: true, deletedJob: false });
  });
});
