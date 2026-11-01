import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const INTERNAL_TOKEN = 'team-tenant-internal-token';

let mongo: MongoMemoryServer;
let server: Server;
let baseUrl: string;

const CONTROLLER_ID = new mongoose.Types.ObjectId();
const HOST_ID = new mongoose.Types.ObjectId();
const KEY_ID = new mongoose.Types.ObjectId();
const USER_ID = new mongoose.Types.ObjectId();
const TENANT_ID = new mongoose.Types.ObjectId();
const ACCOUNT_ID = new mongoose.Types.ObjectId();

beforeAll(async () => {
  process.env.INTERNAL_API_TOKEN = INTERNAL_TOKEN;
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('agent-api-internal-cloud-host-team-tenant'));

  const { internalCloudHostRouter } = await import('./internal-cloud-host.js');
  const { githubService } = await import('../services/github.js');
  vi.spyOn(githubService, 'createRepoScopedToken').mockResolvedValue({
    token: 'ghs_team_scoped',
    expiresAt: new Date('2026-10-30T01:00:00.000Z'),
  });

  const app = express();
  app.use(express.json());
  app.use('/internal/cloud-hosts', internalCloudHostRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.disconnect();
  await mongo.stop();
});

async function seedTeamTenantHost(options: { hostTenantId?: mongoose.Types.ObjectId } = {}): Promise<void> {
  await mongoose.connection.collection('controllers').deleteMany({});
  await mongoose.connection.collection('cloudhosts').deleteMany({});
  await mongoose.connection.collection('cloud_host_github_bindings').deleteMany({});

  await mongoose.connection.collection('controllers').insertOne({
    _id: CONTROLLER_ID,
    userId: USER_ID,
    tenantId: TENANT_ID,
    keyId: KEY_ID,
    name: 'team-host',
    hostname: 'team-host',
    type: 'cloud',
    status: 'online',
    version: '0.0.0',
  });
  await mongoose.connection.collection('cloudhosts').insertOne({
    _id: HOST_ID,
    userId: USER_ID,
    tenantId: options.hostTenantId ?? TENANT_ID,
    name: 'team-host',
    harnessTypes: ['OPENCODE'],
    status: 'RUNNING',
    controllerId: CONTROLLER_ID,
    keyId: KEY_ID,
    deletedAt: null,
  });
  await mongoose.connection.collection('cloud_host_github_bindings').insertOne({
    userId: USER_ID,
    tenantId: options.hostTenantId ?? TENANT_ID,
    controllerId: CONTROLLER_ID,
    accountId: ACCOUNT_ID,
    repoFullName: 'owner/team-repo',
    targetPath: '/home/worker/workspace/team-repo',
  });
}

describe('POST /internal/cloud-hosts/:controllerId/github-credential（团队租户，真库）', () => {
  it('团队租户云电脑（tenantId != userId）仍可取回绑定仓库凭据', async () => {
    await seedTeamTenantHost();

    const response = await fetch(
      `${baseUrl}/internal/cloud-hosts/${CONTROLLER_ID}/github-credential`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      token: 'ghs_team_scoped',
      expiresAt: '2026-10-30T01:00:00.000Z',
    });
  });

  it('云电脑/绑定租户与控制器租户不一致时拒绝下发（跨租户不可见）', async () => {
    const otherTenantId = new mongoose.Types.ObjectId();
    await seedTeamTenantHost({ hostTenantId: otherTenantId });

    const response = await fetch(
      `${baseUrl}/internal/cloud-hosts/${CONTROLLER_ID}/github-credential`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${INTERNAL_TOKEN}` },
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'NOT_FOUND' });
  });
});
