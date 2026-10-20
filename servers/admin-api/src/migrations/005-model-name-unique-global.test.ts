import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/model.js', () => ({
  Model: {
    find: vi.fn(),
    updateOne: vi.fn(),
    collection: {
      indexes: vi.fn(),
      createIndex: vi.fn(),
    },
  },
}));

vi.mock('../models/provider.js', () => ({
  Provider: { find: vi.fn() },
}));

vi.mock('../models/model-rename-record.js', () => ({
  ModelRenameRecord: { updateOne: vi.fn() },
}));

import { Model } from '../models/model.js';
import { Provider } from '../models/provider.js';
import { ModelRenameRecord } from '../models/model-rename-record.js';
import * as migration from './005-model-name-unique-global';

interface MockModel {
  _id: string;
  providerId: string;
  name: string;
  createdAt?: Date | null;
}

function model(id: string, name: string, providerId = 'provider-1', createdAt?: Date | null): MockModel {
  return { _id: id, providerId, name, createdAt: createdAt ?? new Date('2026-01-01T00:00:00Z') };
}

function mockModels(models: MockModel[]) {
  (Model.find as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(models) });
}

function mockProviders(providers: Array<{ _id: string; name: string }>) {
  (Provider.find as any).mockReturnValue({ lean: vi.fn().mockResolvedValue(providers) });
}

describe('migration 005-model-name-unique-global', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockModels([]);
    mockProviders([{ _id: 'provider-1', name: 'OpenAI A' }]);
    (Model.updateOne as any).mockResolvedValue({ modifiedCount: 1 });
    (ModelRenameRecord.updateOne as any).mockResolvedValue({});
    (Model.collection.indexes as any).mockResolvedValue([]);
    (Model.collection.createIndex as any).mockResolvedValue('scope_global_name_unique');
  });

  it('T-MIG30: exposes migration name and constants', () => {
    expect(migration.name).toBe('005-model-name-unique-global');
    expect(migration.BATCH_ID).toBe('20261020-005');
    expect(migration.INDEX_NAME).toBe('scope_global_name_unique');
  });

  it('T-MIG31: no duplicates + index present → no writes, no createIndex', async () => {
    mockModels([model('m1', 'gpt-4o'), model('m2', 'claude')]);
    (Model.collection.indexes as any).mockResolvedValue([{ name: migration.INDEX_NAME }]);

    await migration.run();

    expect(Model.updateOne).not.toHaveBeenCalled();
    expect(ModelRenameRecord.updateOne).not.toHaveBeenCalled();
    expect(Model.collection.createIndex).not.toHaveBeenCalled();
  });

  it('T-MIG32: no duplicates + index missing → creates only the partial unique index', async () => {
    mockModels([model('m1', 'gpt-4o')]);

    await migration.run();

    expect(ModelRenameRecord.updateOne).not.toHaveBeenCalled();
    expect(Model.collection.createIndex).toHaveBeenCalledTimes(1);
    expect(Model.collection.createIndex).toHaveBeenCalledWith(
      { name: 1 },
      { unique: true, partialFilterExpression: { scope: 'global' }, name: migration.INDEX_NAME },
    );
  });

  it('T-MIG33: two providers share gpt-4o → keeps the oldest name, renames the other and records it', async () => {
    mockModels([
      model('m-new', 'gpt-4o', 'provider-2', new Date('2026-02-01T00:00:00Z')),
      model('m-old', 'gpt-4o', 'provider-1', new Date('2026-01-01T00:00:00Z')),
    ]);
    mockProviders([
      { _id: 'provider-1', name: 'OpenAI A' },
      { _id: 'provider-2', name: 'OpenAI B' },
    ]);

    await migration.run();

    expect(Model.updateOne).toHaveBeenCalledTimes(1);
    expect(Model.updateOne).toHaveBeenCalledWith(
      { _id: 'm-new', scope: 'global' },
      { $set: { name: 'gpt-4o-2' } },
    );
    expect(ModelRenameRecord.updateOne).toHaveBeenCalledTimes(1);
    expect(ModelRenameRecord.updateOne).toHaveBeenCalledWith(
      { modelId: 'm-new', batchId: migration.BATCH_ID },
      {
        $setOnInsert: expect.objectContaining({
          providerId: 'provider-2',
          providerName: 'OpenAI B',
          oldName: 'gpt-4o',
          newName: 'gpt-4o-2',
          batchId: migration.BATCH_ID,
        }),
      },
      { upsert: true },
    );
    expect(Model.collection.createIndex).toHaveBeenCalled();
  });

  it('T-MIG34: three duplicates with gpt-4o-2 already used → renames to -3 and -4', async () => {
    mockModels([
      model('m1', 'gpt-4o', 'provider-1', new Date('2026-01-01T00:00:00Z')),
      model('m2', 'gpt-4o', 'provider-1', new Date('2026-02-01T00:00:00Z')),
      model('m3', 'gpt-4o', 'provider-1', new Date('2026-03-01T00:00:00Z')),
      model('m4', 'gpt-4o-2'),
    ]);

    await migration.run();

    const renames = (Model.updateOne as any).mock.calls.map(
      (call: unknown[]) => (call[1] as { $set: { name: string } }).$set.name,
    );
    expect(renames).toEqual(['gpt-4o-3', 'gpt-4o-4']);
    expect(ModelRenameRecord.updateOne).toHaveBeenCalledTimes(2);
  });

  it('T-MIG35: falls back to 未知供应商 when the provider no longer exists', async () => {
    mockModels([model('m1', 'gpt-4o', 'gone'), model('m2', 'gpt-4o', 'gone', new Date('2026-02-01T00:00:00Z'))]);
    mockProviders([]);

    await migration.run();

    expect(ModelRenameRecord.updateOne).toHaveBeenCalledWith(
      expect.anything(),
      { $setOnInsert: expect.objectContaining({ providerName: '未知供应商', oldName: 'gpt-4o', newName: 'gpt-4o-2' }) },
      { upsert: true },
    );
  });

  it('T-MIG36: propagates createIndex failures instead of swallowing them', async () => {
    (Model.collection.createIndex as any).mockRejectedValue(new Error('IndexOptionsConflict'));

    await expect(migration.run()).rejects.toThrow('IndexOptionsConflict');
  });

  it('T-MIG37: rerun after cleanup is a no-op (no duplicate ledger entries)', async () => {
    mockModels([model('m1', 'gpt-4o'), model('m2', 'gpt-4o-2')]);
    (Model.collection.indexes as any).mockResolvedValue([{ name: migration.INDEX_NAME }]);

    await migration.run();

    expect(Model.updateOne).not.toHaveBeenCalled();
    expect(ModelRenameRecord.updateOne).not.toHaveBeenCalled();
    expect(Model.collection.createIndex).not.toHaveBeenCalled();
  });

  it('T-MIG38: writes the ledger before renaming so a crash cannot leave a rename without a record (C-11)', async () => {
    mockModels([
      model('m-old', 'gpt-4o', 'provider-1', new Date('2026-01-01T00:00:00Z')),
      model('m-new', 'gpt-4o', 'provider-2', new Date('2026-02-01T00:00:00Z')),
    ]);

    await migration.run();

    const ledgerOrder = (ModelRenameRecord.updateOne as any).mock.invocationCallOrder[0];
    const renameOrder = (Model.updateOne as any).mock.invocationCallOrder[0];
    expect(ledgerOrder).toBeLessThan(renameOrder);
    // upsert 键固定为 (modelId, batchId)，重复执行不会产生第二条台账
    expect(ModelRenameRecord.updateOne).toHaveBeenCalledWith(
      { modelId: 'm-new', batchId: migration.BATCH_ID },
      expect.anything(),
      { upsert: true },
    );
  });
});
