import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { CloudHost } from './cloud-host.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../services/billing/testing/mongo.js';

describe('CloudHost 只读模型（cloudhosts）', () => {
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
  });

  it('集合名为 cloudhosts，包含鉴权/对账所需字段', () => {
    expect(CloudHost.collection.name).toBe('cloudhosts');
    expect(mongoose.model('CloudHost')).toBe(CloudHost);
    const paths = Object.keys(CloudHost.schema.paths);
    expect(paths).toEqual(expect.arrayContaining(['userId', 'status', 'controllerId', 'deletedAt']));
  });

  it('按 _id 读取宿主状态/软删除标记，读取过程不写库', async () => {
    const _id = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const controllerId = new mongoose.Types.ObjectId();
    const updatedAt = new Date('2026-10-20T00:00:00.000Z');
    await mongoose.connection.db!.collection('cloudhosts').insertOne({
      _id,
      userId,
      controllerId,
      status: 'RUNNING',
      deletedAt: null,
      createdAt: new Date('2026-10-20T00:00:00.000Z'),
      updatedAt,
    });

    const doc = await CloudHost.findById(_id).lean();
    expect(doc).toMatchObject({ status: 'RUNNING', deletedAt: null });
    expect(String(doc?.userId)).toBe(userId.toString());
    expect(String(doc?.controllerId)).toBe(controllerId.toString());

    const raw = await mongoose.connection.db!
      .collection('cloudhosts')
      .findOne({ _id });
    expect(raw?.status).toBe('RUNNING');
    expect(new Date(raw!.updatedAt as Date).getTime()).toBe(updatedAt.getTime());
    expect(await mongoose.connection.db!.collection('cloudhosts').countDocuments()).toBe(1);
  });

  it('软删除宿主可被识别（deletedAt 非空）', async () => {
    const _id = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('cloudhosts').insertOne({
      _id,
      userId: new mongoose.Types.ObjectId(),
      controllerId: new mongoose.Types.ObjectId(),
      status: 'STOPPED',
      deletedAt: new Date(),
    });
    const doc = await CloudHost.findById(_id).lean();
    expect(doc?.deletedAt).toBeInstanceOf(Date);
  });
});
