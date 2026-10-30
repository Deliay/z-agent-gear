import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const TEAM_TENANT_ID = new mongoose.Types.ObjectId();
const TEAM_WORKSPACE_ID = new mongoose.Types.ObjectId();
const MEMBER_ID = new mongoose.Types.ObjectId();
const OUTSIDER_ID = new mongoose.Types.ObjectId();
const PERSONAL_USER_ID = new mongoose.Types.ObjectId();
const CONTROLLER_ID = new mongoose.Types.ObjectId();

let mongo: MongoMemoryServer;
let server: Server;
let baseUrl: string;

interface Captured {
  sessionId: string;
  userId: string;
  workspace: ReturnType<typeof import('../services/workspace-context.js').getWorkspaceContext>;
  sessionFound: boolean;
}

const calls: Captured[] = [];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('session-stream-team-tenant'));

  const { sessionStreamRouter } = await import('./session-stream.js');
  const { sessionSSEService } = await import('../services/session-sse.js');
  const { sessionService } = await import('../services/session.js');
  const { getWorkspaceContext } = await import('../services/workspace-context.js');

  vi.spyOn(sessionSSEService, 'addConnection').mockImplementation(
    (async (sessionId: string, userId: string, res: import('express').Response) => {
      const session = await sessionService.findById(sessionId, userId);
      calls.push({
        sessionId,
        userId,
        workspace: getWorkspaceContext(),
        sessionFound: Boolean(session),
      });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end();
    }) as never,
  );

  const app = express();
  app.use('/api', sessionStreamRouter);
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

beforeEach(async () => {
  calls.length = 0;
  vi.clearAllMocks();
  await Promise.all([
    mongoose.connection.collection('tenants').deleteMany({}),
    mongoose.connection.collection('users').deleteMany({}),
    mongoose.connection.collection('workspaces').deleteMany({}),
    mongoose.connection.collection('tenantmembers').deleteMany({}),
    mongoose.connection.collection('sessions').deleteMany({}),
  ]);

  await mongoose.connection.collection('tenants').insertMany([
    { _id: TEAM_TENANT_ID, name: 'Team', type: 'team' },
    { _id: PERSONAL_USER_ID, name: 'personal', type: 'personal' },
  ]);
  await mongoose.connection.collection('users').insertMany([
    { _id: MEMBER_ID, tenantId: TEAM_TENANT_ID, name: 'Member', username: 'member' },
    { _id: OUTSIDER_ID, tenantId: OUTSIDER_ID, name: 'Outsider', username: 'outsider' },
    { _id: PERSONAL_USER_ID, tenantId: PERSONAL_USER_ID, name: 'Personal', username: 'personal' },
  ]);
  await mongoose.connection.collection('workspaces').insertOne({
    _id: TEAM_WORKSPACE_ID,
    tenantId: TEAM_TENANT_ID,
    name: '全局工作区',
    type: 'global',
  });
  await mongoose.connection.collection('tenantmembers').insertOne({
    tenantId: TEAM_TENANT_ID,
    userId: MEMBER_ID,
    role: 'developer',
    createdBy: 'test',
  });
});

async function seedSession(id: mongoose.Types.ObjectId, overrides: Record<string, unknown> = {}) {
  await mongoose.connection.collection('sessions').insertOne({
    _id: id,
    userId: MEMBER_ID,
    tenantId: TEAM_TENANT_ID,
    workspaceId: TEAM_WORKSPACE_ID,
    controllerId: CONTROLLER_ID,
    controllerName: 'ctl',
    acpServerType: 'opencode',
    status: 'idling',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

async function stream(id: string, userId: mongoose.Types.ObjectId): Promise<Response> {
  const { signToken } = await import('../services/auth.js');
  const token = signToken(String(userId));
  return fetch(`${baseUrl}/api/session/${id}/stream?token=${encodeURIComponent(token)}`);
}

describe('GET /api/session/:id/stream（团队租户，真库）', () => {
  it('T-SSE-TEAM1：团队成员可订阅本工作区会话（不再按 tenantId=userId 过滤）', async () => {
    const sessionId = new mongoose.Types.ObjectId();
    await seedSession(sessionId);

    const res = await stream(String(sessionId), MEMBER_ID);

    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe(String(sessionId));
    expect(calls[0].userId).toBe(String(MEMBER_ID));
    expect(calls[0].workspace?.id).toBe(String(TEAM_WORKSPACE_ID));
    expect(calls[0].workspace?.tenantId).toBe(String(TEAM_TENANT_ID));
    expect(calls[0].sessionFound).toBe(true);
  }, 20_000);

  it('T-SSE-TEAM2：非团队成员访问返回 404 且不建立流', async () => {
    const sessionId = new mongoose.Types.ObjectId();
    await seedSession(sessionId);

    const res = await stream(String(sessionId), OUTSIDER_ID);

    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  }, 20_000);

  it('T-SSE-TEAM3：会话不存在返回 404', async () => {
    const res = await stream(String(new mongoose.Types.ObjectId()), MEMBER_ID);

    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  }, 20_000);

  it('T-SSE-TEAM4：个人租户历史会话（tenantId=userId、无工作区）保持原口径', async () => {
    const sessionId = new mongoose.Types.ObjectId();
    await seedSession(sessionId, {
      userId: PERSONAL_USER_ID,
      tenantId: PERSONAL_USER_ID,
      workspaceId: null,
    });

    const res = await stream(String(sessionId), PERSONAL_USER_ID);

    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect(calls).toHaveLength(1);
    expect(calls[0].workspace).toBeUndefined();
    expect(calls[0].sessionFound).toBe(true);
  }, 20_000);
});
