import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/cloud-workload.js', () => ({
  CloudWorkload: { findOne: vi.fn() },
}));

import { CloudWorkload } from '../models/cloud-workload.js';
import * as migration from './008-fix-github-workload-prefix';

function field(overrides: Record<string, unknown> = {}) {
  return {
    key: 'targetPath',
    label: 'Clone 目标路径',
    type: 'text',
    options: [],
    defaultValue: migration.LEGACY_GITHUB_TARGET_PATH,
    ...overrides,
  };
}

function docWith(fields: Array<Record<string, unknown>>) {
  return {
    _id: 'github-1',
    presetKey: 'github',
    name: 'Github',
    paramSchema: fields,
    markModified: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

describe('migration 008-fix-github-workload-prefix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    (CloudWorkload.findOne as any).mockResolvedValue(null);
  });

  it('exposes the migration name', () => {
    expect(migration.name).toBe('008-fix-github-workload-prefix');
  });

  it('T-MIG8-1: 旧默认值与旧 label 被更新为前缀地址', async () => {
    const doc = docWith([{ key: 'repoFullName', defaultValue: '' }, field()]);
    (CloudWorkload.findOne as any).mockResolvedValue(doc);

    await migration.run();

    expect(CloudWorkload.findOne).toHaveBeenCalledWith({ presetKey: 'github' });
    const target = (doc.paramSchema as Array<Record<string, unknown>>)[1];
    expect(target.defaultValue).toBe(migration.GITHUB_PREFIX_DEFAULT);
    expect(target.label).toBe('Clone 前缀地址');
    expect(doc.markModified).toHaveBeenCalledWith('paramSchema');
    expect(doc.save).toHaveBeenCalledTimes(1);
  });

  it('T-MIG8-2: 重复执行无变化、不报错（幂等）', async () => {
    const doc = docWith([field({ defaultValue: migration.GITHUB_PREFIX_DEFAULT, label: 'Clone 前缀地址' })]);
    (CloudWorkload.findOne as any).mockResolvedValue(doc);

    await migration.run();
    await migration.run();

    expect(doc.save).not.toHaveBeenCalled();
  });

  it('T-MIG8-3: 管理员已自定义默认值时不覆盖', async () => {
    const doc = docWith([field({ defaultValue: '/custom/path', label: '我的路径' })]);
    (CloudWorkload.findOne as any).mockResolvedValue(doc);

    await migration.run();

    const target = (doc.paramSchema as Array<Record<string, unknown>>)[0];
    expect(target.defaultValue).toBe('/custom/path');
    expect(target.label).toBe('我的路径');
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('T-MIG8-4: 无 github 预制项或无 targetPath 时静默跳过', async () => {
    await migration.run();
    expect(CloudWorkload.findOne).toHaveBeenCalledTimes(1);

    const doc = docWith([{ key: 'other', defaultValue: 'x' }]);
    (CloudWorkload.findOne as any).mockResolvedValue(doc);
    await migration.run();

    expect(doc.save).not.toHaveBeenCalled();
    expect(doc.markModified).not.toHaveBeenCalled();
  });

  it('T-MIG8-5: paramSchema 非数组时跳过（历史脏数据）', async () => {
    const doc = docWith([]);
    (doc as unknown as Record<string, unknown>).paramSchema = null;
    (CloudWorkload.findOne as any).mockResolvedValue(doc);

    await migration.run();

    expect(doc.save).not.toHaveBeenCalled();
  });
});
