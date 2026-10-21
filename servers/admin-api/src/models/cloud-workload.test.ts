import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { CloudWorkload } from './cloud-workload.js';
import { connectTestDb, clearTestDb, disconnectTestDb } from '../services/billing/testing/mongo.js';

describe('CloudWorkload 存量兼容（workloadKind/harnessType）', () => {
  beforeAll(async () => {
    await connectTestDb();
  }, 60000);
  afterAll(async () => {
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await clearTestDb();
  });

  it('T-MIG5-5: 无新字段的存量文档读取为 standard/null', async () => {
    const _id = new mongoose.Types.ObjectId();
    await mongoose.connection.db!.collection('cloudworkloads').insertOne({
      _id,
      name: 'legacy-workload',
      initScript: '#!/usr/bin/env bash\necho legacy\n',
      postScript: null,
      paramSchema: [],
      dependsOnWorkloadIds: [],
      presetKey: null,
      isPreset: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const doc = await CloudWorkload.findById(_id);
    expect(doc?.workloadKind).toBe('standard');
    expect(doc?.harnessType).toBeNull();

    // 原始文档不被迁移/读取过程改写
    const raw = await mongoose.connection.db!
      .collection('cloudworkloads')
      .findOne({ _id });
    expect(raw?.workloadKind).toBeUndefined();
    expect(raw?.harnessType).toBeUndefined();
  });

  it('T-MIG5-5: 既有 4 个预制项保持 standard/null，harness 预制项为 harness/opencode', async () => {
    for (const presetKey of ['docker', 'nodejs', 'dotnet', 'aspire']) {
      await CloudWorkload.create({
        name: presetKey,
        initScript: '#!/usr/bin/env bash\nexit 0\n',
        presetKey,
        isPreset: true,
      });
    }
    await CloudWorkload.create({
      name: 'OpenCode（Harness）',
      initScript: '#!/usr/bin/env bash\nexit 0\n',
      presetKey: 'harness-opencode',
      isPreset: true,
      workloadKind: 'harness',
      harnessType: 'opencode',
      paramSchema: [],
    });

    const standard = await CloudWorkload.find({ presetKey: { $in: ['docker', 'nodejs', 'dotnet', 'aspire'] } }).lean();
    expect(standard).toHaveLength(4);
    expect(standard.every((doc) => doc.workloadKind === 'standard')).toBe(true);
    expect(standard.every((doc) => doc.harnessType === null)).toBe(true);

    const harness = await CloudWorkload.findOne({ presetKey: 'harness-opencode' }).lean();
    expect(harness).toMatchObject({ workloadKind: 'harness', harnessType: 'opencode', isPreset: true });
  });

  it('拒绝非法 workloadKind/harnessType', async () => {
    await expect(
      CloudWorkload.create({
        name: 'bad-kind',
        initScript: 'x',
        workloadKind: 'other',
      }),
    ).rejects.toThrow();
    await expect(
      CloudWorkload.create({
        name: 'bad-harness',
        initScript: 'x',
        workloadKind: 'harness',
        harnessType: 'claude',
      }),
    ).rejects.toThrow();
  });
});
