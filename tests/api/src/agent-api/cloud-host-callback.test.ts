import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { fundFrontUser } from './funding.js';
import { createFrontUser } from '../support/front-users.js';

// 内部 ready/terminal 回调（cloud-controller → agent-api）。
// 需要 Aspire 全量服务 + Mongo + INTERNAL_API_TOKEN；无需真实 worker。
const GRAPHQL_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const API_BASE = GRAPHQL_URL.replace(/\/graphql\/?$/, '');
const TOKEN = process.env.INTERNAL_API_TOKEN;
const HAS_MONGO = Boolean(process.env.MONGODB_URI);
const ADMIN_BASE = (process.env.ADMIN_API_URL || 'http://localhost:10003/graphql').replace(
  /\/graphql\/?$/,
  '',
);

function gql(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(GRAPHQL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  }).then((res) => res.json() as Promise<{ data?: any; errors?: Array<{ message: string }> }>);
}

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(uri);
  return mongoose.connection.db ?? null;
}

async function callback(path: string, body?: unknown, token = TOKEN) {
  return fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function seedHost(db: mongoose.mongo.Db, options: {
  userId: string;
  status: 'STARTING' | 'RUNNING';
  harnessTypes?: string[];
  createDefaultSession?: boolean;
}) {
  const hostId = new mongoose.Types.ObjectId();
  const controllerId = new mongoose.Types.ObjectId();
  const keyId = new mongoose.Types.ObjectId();
  const workspaceId = new mongoose.Types.ObjectId();
  const now = new Date();
  await db.collection('controllers').insertOne({
    _id: controllerId,
    userId: new mongoose.Types.ObjectId(options.userId),
    tenantId: new mongoose.Types.ObjectId(options.userId),
    name: `cb-${hostId.toString()}`,
    hostname: `cb-${hostId.toString()}`,
    type: 'cloud',
    status: 'registering',
    keyId,
    version: '0.0.0',
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('controllerworkspaces').insertOne({
    _id: workspaceId,
    userId: new mongoose.Types.ObjectId(options.userId),
    tenantId: new mongoose.Types.ObjectId(options.userId),
    controllerId,
    name: 'workspace',
    path: '/home/worker/workspace',
    isEnabled: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('cloudhosts').insertOne({
    _id: hostId,
    userId: new mongoose.Types.ObjectId(options.userId),
    tenantId: new mongoose.Types.ObjectId(options.userId),
    name: `cb-${hostId.toString()}`,
    harnessTypes: options.harnessTypes ?? ['OPENCODE'],
    status: options.status,
    controllerId,
    keyId,
    workspaceId,
    containerId: `container-${hostId.toString()}`,
    defaultSessionId: null,
    createDefaultSession: options.createDefaultSession ?? true,
    startedAt: now,
    readyAt: options.status === 'RUNNING' ? now : null,
    stoppedAt: null,
    failureReason: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return { hostId: hostId.toString(), controllerId: controllerId.toString() };
}

/** 兜底清理单个用例创建的 host/controller/workspace 及其会话（仅匹配本用例生成的 controllerId）。 */
async function cleanupHost(
  db: mongoose.mongo.Db,
  fixture: { hostId: string; controllerId: string },
): Promise<void> {
  const controllerId = new mongoose.Types.ObjectId(fixture.controllerId);
  await db.collection('sessions').deleteMany({ controllerId });
  await db.collection('cloudhosts').deleteOne({ _id: new mongoose.Types.ObjectId(fixture.hostId) });
  await db.collection('controllerworkspaces').deleteMany({ controllerId });
  await db.collection('controllers').deleteOne({ _id: controllerId });
}

/** 为直插的云电脑补一笔真实创建扣费（用于 terminal 退款断言）。 */
async function chargeHost(
  db: mongoose.mongo.Db,
  userId: string,
  hostId: string,
): Promise<{ accountId: string; cashBalance: number }> {
  await fundFrontUser(userId, userId);
  const account = await db.collection('billingaccounts').findOne({
    ownerType: 'tenant',
    ownerId: userId,
  });
  const accountId = String(account!._id);
  const res = await fetch(`${ADMIN_BASE}/internal/billing/charges`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      accountId,
      productId: 'cloud_host.create',
      quantity: 1,
      idempotentKey: `cloud_host.create:${hostId}`,
      refType: 'cloud_host',
      refId: hostId,
      description: '创建云电脑 callback-test',
    }),
  });
  expect(res.status).toBe(200);
  const after = await db.collection('billingaccounts').findOne({ _id: account!._id });
  return { accountId, cashBalance: after?.cashBalance ?? 0 };
}

describe.skipIf(!TOKEN || !HAS_MONGO)('Cloud Host callbacks', () => {
  it('rejects missing/invalid internal token', async () => {
    const hostId = new mongoose.Types.ObjectId().toString();
    expect((await callback(`/internal/cloud-hosts/${hostId}/ready`, undefined, 'wrong')).status).toBe(401);
    expect((await callback(`/internal/cloud-hosts/${hostId}/ready`, undefined, '')).status).toBe(401);
  });

  it('T-CH19: ready drives RUNNING and creates exactly one default session', async () => {
    const db = (await mongoDb())!;
    const frontUser = await createFrontUser();
    const userId = frontUser.userId;
    let fixture: Awaited<ReturnType<typeof seedHost>> | undefined;
    try {
      fixture = await seedHost(db, { userId, status: 'STARTING' });
      const { hostId, controllerId } = fixture;

      const ready = await callback(`/internal/cloud-hosts/${hostId}/ready`);
      expect(ready.status).toBe(200);
      const body = (await ready.json()) as { status: string; defaultSessionId: string | null };
      expect(body.status).toBe('RUNNING');
      expect(body.defaultSessionId).toBeTruthy();

      const sessionCount = await db.collection('sessions').countDocuments({
        controllerId: new mongoose.Types.ObjectId(controllerId),
      });
      expect(sessionCount).toBe(1);

      // 重复回调幂等：不重复建默认会话
      const again = await callback(`/internal/cloud-hosts/${hostId}/ready`);
      expect(again.status).toBe(200);
      expect(
        await db.collection('sessions').countDocuments({
          controllerId: new mongoose.Types.ObjectId(controllerId),
        }),
      ).toBe(1);
    } finally {
      if (fixture) await cleanupHost(db, fixture);
    }
  });

  it('T-CH21: multiple harness types do not create a default session', async () => {
    const db = (await mongoDb())!;
    const frontUser = await createFrontUser();
    const userId = frontUser.userId;
    let fixture: Awaited<ReturnType<typeof seedHost>> | undefined;
    try {
      fixture = await seedHost(db, {
        userId,
        status: 'STARTING',
        harnessTypes: ['OPENCODE', 'CODEX'],
      });
      const { hostId, controllerId } = fixture;

      const ready = await callback(`/internal/cloud-hosts/${hostId}/ready`);
      expect(ready.status).toBe(200);
      const body = (await ready.json()) as { status: string; defaultSessionId: string | null };
      expect(body.defaultSessionId).toBeNull();
      expect(body.status).toBe('RUNNING');

      // 多 harness：主机就绪但绝不自动建会话
      expect(
        await db.collection('sessions').countDocuments({
          controllerId: new mongoose.Types.ObjectId(controllerId),
        }),
      ).toBe(0);
      const host = await db.collection('cloudhosts').findOne({
        _id: new mongoose.Types.ObjectId(hostId),
      });
      expect(host).toMatchObject({ status: 'RUNNING', defaultSessionId: null });
    } finally {
      if (fixture) await cleanupHost(db, fixture);
    }
  });

  it('T-CH21b: createDefaultSession=false 时单 harness 也不建默认会话', async () => {
    const db = (await mongoDb())!;
    const frontUser = await createFrontUser();
    const userId = frontUser.userId;
    let fixture: Awaited<ReturnType<typeof seedHost>> | undefined;
    try {
      fixture = await seedHost(db, {
        userId,
        status: 'STARTING',
        harnessTypes: ['OPENCODE'],
        createDefaultSession: false,
      });
      const { hostId, controllerId } = fixture;

      const ready = await callback(`/internal/cloud-hosts/${hostId}/ready`);
      expect(ready.status).toBe(200);
      const body = (await ready.json()) as { status: string; defaultSessionId: string | null };
      expect(body.status).toBe('RUNNING');
      expect(body.defaultSessionId).toBeNull();
      expect(
        await db.collection('sessions').countDocuments({
          controllerId: new mongoose.Types.ObjectId(controllerId),
        }),
      ).toBe(0);
    } finally {
      if (fixture) await cleanupHost(db, fixture);
    }
  });

  it('T-CH22: terminal ends sessions and is idempotent', async () => {
    const db = (await mongoDb())!;
    const frontUser = await createFrontUser();
    const userId = frontUser.userId;
    let fixture: Awaited<ReturnType<typeof seedHost>> | undefined;
    try {
      fixture = await seedHost(db, { userId, status: 'RUNNING' });
      const { hostId, controllerId } = fixture;
      const now = new Date();
      await db.collection('sessions').insertOne({
        userId: new mongoose.Types.ObjectId(userId),
        tenantId: new mongoose.Types.ObjectId(userId),
        controllerId: new mongoose.Types.ObjectId(controllerId),
        controllerName: 'cloud',
        acpServerType: 'opencode',
        status: 'idling',
        title: 'active',
        createdAt: now,
        updatedAt: now,
      });

      const terminal = await callback(`/internal/cloud-hosts/${hostId}/terminal`, {
        status: 'stopped',
      });
      expect(terminal.status).toBe(200);
      expect((await terminal.json()) as { status: string }).toMatchObject({ status: 'STOPPED' });

      const session = await db.collection('sessions').findOne({
        controllerId: new mongoose.Types.ObjectId(controllerId),
      });
      expect(session?.status).toBe('ended');
      expect(session?.endedAt).toBeTruthy();

      const again = await callback(`/internal/cloud-hosts/${hostId}/terminal`, { status: 'stopped' });
      expect(again.status).toBe(200);
    } finally {
      if (fixture) await cleanupHost(db, fixture);
    }
  });

  it('T-CH22: terminal failed drives FAILED with reason', async () => {
    const db = (await mongoDb())!;
    const frontUser = await createFrontUser();
    const userId = frontUser.userId;
    let fixture: Awaited<ReturnType<typeof seedHost>> | undefined;
    try {
      fixture = await seedHost(db, { userId, status: 'RUNNING' });
      const { hostId } = fixture;

      const terminal = await callback(`/internal/cloud-hosts/${hostId}/terminal`, {
        status: 'failed',
        reason: 'harness init failed',
      });
      expect(terminal.status).toBe(200);
      expect(await terminal.json()).toMatchObject({
        status: 'FAILED',
        failureReason: 'harness init failed',
      });
      const host = await db.collection('cloudhosts').findOne({
        _id: new mongoose.Types.ObjectId(hostId),
      });
      expect(host).toMatchObject({ status: 'FAILED', containerId: null });
    } finally {
      if (fixture) await cleanupHost(db, fixture);
    }
  });

  it('T-CH-API-B5: 未 ready terminal 自动退款并留痕', async () => {
    const db = (await mongoDb())!;
    const frontUser = await createFrontUser();
    const userId = frontUser.userId;
    let fixture: Awaited<ReturnType<typeof seedHost>> | undefined;
    try {
      fixture = await seedHost(db, { userId, status: 'STARTING' });
      const { hostId } = fixture;
      const charged = await chargeHost(db, userId, hostId);
      expect(charged.cashBalance).toBe(9500);

      const terminal = await callback(`/internal/cloud-hosts/${hostId}/terminal`, {
        status: 'failed',
        reason: 'start failed',
      });
      expect(terminal.status).toBe(200);

      const adjust = await db.collection('billinginvoices').findOne({
        refType: 'cloud_host',
        refId: hostId,
        type: 'adjust',
      });
      expect(adjust).toMatchObject({ amount: 500 });
      const after = await db.collection('billingaccounts').findOne({
        _id: new mongoose.Types.ObjectId(charged.accountId),
      });
      expect(after?.cashBalance).toBe(10000);
    } finally {
      if (fixture) await cleanupHost(db, fixture);
    }
  });

  it('T-CH-API-B6: ready 后 terminal 不退款', async () => {
    const db = (await mongoDb())!;
    const frontUser = await createFrontUser();
    const userId = frontUser.userId;
    let fixture: Awaited<ReturnType<typeof seedHost>> | undefined;
    try {
      fixture = await seedHost(db, { userId, status: 'RUNNING' });
      const { hostId } = fixture;
      const charged = await chargeHost(db, userId, hostId);
      expect(charged.cashBalance).toBe(9500);

      const terminal = await callback(`/internal/cloud-hosts/${hostId}/terminal`, {
        status: 'stopped',
      });
      expect(terminal.status).toBe(200);
      const adjust = await db.collection('billinginvoices').findOne({
        refType: 'cloud_host',
        refId: hostId,
        type: 'adjust',
      });
      expect(adjust).toBeNull();
      const after = await db.collection('billingaccounts').findOne({
        _id: new mongoose.Types.ObjectId(charged.accountId),
      });
      expect(after?.cashBalance).toBe(9500);
    } finally {
      if (fixture) await cleanupHost(db, fixture);
    }
  });

  it('returns 404 for unknown host', async () => {
    const unknown = new mongoose.Types.ObjectId().toString();
    expect((await callback(`/internal/cloud-hosts/${unknown}/ready`)).status).toBe(404);
  });
});
