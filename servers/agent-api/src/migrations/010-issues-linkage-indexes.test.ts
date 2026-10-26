import { describe, it, expect, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import * as migration from './010-issues-linkage-indexes.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('migration 010 issues linkage indexes', () => {
  it('exposes the migration name', () => {
    expect(migration.name).toBe('010-issues-linkage-indexes');
  });

  it('creates linkage and trigger indexes (含两个唯一索引)', async () => {
    const createIndex = vi.fn().mockResolvedValue('ok');
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ createIndex } as never);

    await migration.run();

    const collections = vi.mocked(mongoose.connection.collection).mock.calls.map((c) => c[0]);
    expect(collections).toEqual(['cloud_host_issues_linkages', 'issue_workflow_triggers']);
    expect(createIndex).toHaveBeenCalledWith(
      { controllerId: 1, labelNameLower: 1 },
      { unique: true, name: 'uniq_cloud_host_issues_linkage_label' },
    );
    expect(createIndex).toHaveBeenCalledWith(
      { controllerId: 1, repoFullName: 1, labelName: 1, issueId: 1 },
      { unique: true, name: 'uniq_issue_workflow_trigger' },
    );
  });

  it('失败上抛，迁移下次启动重试', async () => {
    const createIndex = vi.fn().mockRejectedValue(new Error('E11000 duplicate key'));
    vi.spyOn(mongoose.connection, 'collection').mockReturnValue({ createIndex } as never);

    await expect(migration.run()).rejects.toThrow('E11000');
  });
});
