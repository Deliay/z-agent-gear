import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import * as migration from './024-resource-workspace-backfill.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-migration-024-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const db = () => mongoose.connection.db!;

beforeEach(async () => {
  await db().dropDatabase();
});

const teamId = new mongoose.Types.ObjectId();
const workspaceId = new mongoose.Types.ObjectId();

async function seedController() {
  const controllerId = new mongoose.Types.ObjectId();
  await db().collection('controllers').insertOne({
    _id: controllerId,
    tenantId: teamId,
    workspaceId,
    userId: new mongoose.Types.ObjectId(),
    keyId: new mongoose.Types.ObjectId(),
    hostname: 'h',
    type: 'local',
    version: '1',
  });
  return controllerId;
}

describe('migration 024-resource-workspace-backfill', () => {
  it('exposes the migration name', () => {
    expect(migration.name).toBe('024-resource-workspace-backfill');
  });

  it('backfills null workspace fields from the owning controller (and tenant)', async () => {
    const controllerId = await seedController();
    await db().collection('cloudhosts').insertOne({
      _id: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      tenantId: teamId,
      controllerId,
      keyId: new mongoose.Types.ObjectId(),
      name: 'host',
      resourceWorkspaceId: null,
    });
    await db().collection('configuredworkflows').insertOne({
      _id: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      tenantId: new mongoose.Types.ObjectId(), // 可能是个人租户（后台链路误写）
      controllerId,
      name: 'cfg',
      resourceWorkspaceId: null,
    });
    await db().collection('sessions').insertOne({
      _id: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      tenantId: new mongoose.Types.ObjectId(),
      controllerId,
      controllerName: 'h',
      acpServerType: 'opencode',
      status: 'idling',
      workspaceId: null,
    });
    // 控制器已删除/无归属 → 不猜测，保持 null
    await db().collection('cloudhosts').insertOne({
      _id: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      tenantId: teamId,
      controllerId: new mongoose.Types.ObjectId(),
      keyId: new mongoose.Types.ObjectId(),
      name: 'orphan',
      resourceWorkspaceId: null,
    });

    await migration.run();

    const host = await db().collection('cloudhosts').findOne({ name: 'host' });
    expect(host?.resourceWorkspaceId).toEqual(workspaceId);
    const orphan = await db().collection('cloudhosts').findOne({ name: 'orphan' });
    expect(orphan?.resourceWorkspaceId).toBeNull();

    const cfg = await db().collection('configuredworkflows').findOne({ name: 'cfg' });
    expect(cfg?.resourceWorkspaceId).toEqual(workspaceId);
    expect(cfg?.tenantId).toEqual(teamId);

    const session = await db().collection('sessions').findOne({ controllerName: 'h' });
    expect(session?.workspaceId).toEqual(workspaceId);
    expect(session?.tenantId).toEqual(teamId);
  });

  it('backfills workflow instances from the configured workflow when controller derivation is unavailable', async () => {
    const cfgId = new mongoose.Types.ObjectId();
    await db().collection('configuredworkflows').insertOne({
      _id: cfgId,
      userId: new mongoose.Types.ObjectId(),
      tenantId: teamId,
      controllerId: new mongoose.Types.ObjectId(),
      name: 'cfg',
      resourceWorkspaceId: workspaceId,
    });
    await db().collection('workflowinstances').insertOne({
      _id: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      tenantId: new mongoose.Types.ObjectId(),
      configuredWorkflowId: cfgId,
      controllerId: new mongoose.Types.ObjectId(),
      name: 'inst',
      resourceWorkspaceId: null,
    });

    await migration.run();

    const instance = await db().collection('workflowinstances').findOne({ name: 'inst' });
    expect(instance?.resourceWorkspaceId).toEqual(workspaceId);
    expect(instance?.tenantId).toEqual(teamId);
  });

  it('is idempotent on re-run', async () => {
    const controllerId = await seedController();
    await db().collection('cloudhosts').insertOne({
      _id: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(),
      tenantId: teamId,
      controllerId,
      keyId: new mongoose.Types.ObjectId(),
      name: 'host',
      resourceWorkspaceId: null,
    });

    await migration.run();
    await migration.run();

    const host = await db().collection('cloudhosts').findOne({ name: 'host' });
    expect(host?.resourceWorkspaceId).toEqual(workspaceId);
  });
});
