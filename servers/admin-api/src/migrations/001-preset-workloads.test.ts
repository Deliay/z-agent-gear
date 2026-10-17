import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/cloud-workload.js', () => ({
  CloudWorkload: { findOne: vi.fn(), create: vi.fn() },
}));

import { CloudWorkload } from '../models/cloud-workload.js';
import * as migration from './001-preset-workloads';

type CreateArg = {
  name: string;
  initScript: string;
  postScript: null;
  paramSchema: Array<Record<string, unknown>>;
  dependsOnWorkloadIds: string[];
  presetKey: string;
  isPreset: boolean;
};

function createdArgs(): CreateArg[] {
  return (CloudWorkload.create as any).mock.calls.map((call: unknown[]) => call[0] as CreateArg);
}

describe('migration 001-preset-workloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 默认：没有任何同名/presetKey 已存在项
    (CloudWorkload.findOne as any).mockResolvedValue(null);
    (CloudWorkload.create as any).mockImplementation((doc: { name: string }) =>
      Promise.resolve({ _id: `id-${doc.name}` }),
    );
  });

  it('exposes the migration name', () => {
    expect(migration.name).toBe('001-preset-workloads');
  });

  it('T-MIG1: inserts the four presets and points Aspire at Docker/.NET', async () => {
    await migration.run();

    const args = createdArgs();
    expect(args).toHaveLength(4);
    expect(args.map((arg) => arg.presetKey)).toEqual(['docker', 'nodejs', 'dotnet', 'aspire']);
    expect(args.every((arg) => arg.isPreset === true)).toBe(true);
    expect(args.every((arg) => arg.postScript === null)).toBe(true);

    // Docker 脚本启动 dockerd
    expect(args[0].initScript).toContain('nohup dockerd');
    expect(args[0].dependsOnWorkloadIds).toEqual([]);

    // Node.js 参数：version（TEXT 默认 22）、package_manager（MULTI_SELECT 默认 ["npm"]）
    expect(args[1].paramSchema).toEqual([
      { key: 'version', label: 'Node.js 版本', type: 'text', options: [], defaultValue: '22' },
      {
        key: 'package_manager',
        label: '包管理器',
        type: 'multi_select',
        options: ['npm', 'pnpm', 'bun', 'yarn'],
        defaultValue: ['npm'],
      },
    ]);

    // Aspire 依赖 Docker → .NET（顺序固定）
    expect(args[3].dependsOnWorkloadIds).toEqual(['id-Docker', 'id-.NET']);
    expect(args[3].initScript).toContain('aspire --version');
  });

  it('T-MIG2: is idempotent — a second run does not re-insert', async () => {
    await migration.run();
    expect(CloudWorkload.create).toHaveBeenCalledTimes(4);

    // 第二次：所有 presetKey 均已存在
    (CloudWorkload.findOne as any).mockImplementation((filter: { presetKey?: string }) =>
      filter.presetKey ? Promise.resolve({ _id: `existing-${filter.presetKey}` }) : Promise.resolve(null),
    );
    (CloudWorkload.create as any).mockClear();

    await migration.run();

    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });

  it('T-MIG3: keeps an existing preset (by presetKey) and never overwrites it', async () => {
    (CloudWorkload.findOne as any).mockImplementation((filter: { presetKey?: string; name?: string }) => {
      if (filter.presetKey === 'docker') return Promise.resolve({ _id: 'existing-docker' });
      if (filter.name === 'Node.js') return Promise.resolve({ _id: 'existing-nodejs' });
      return Promise.resolve(null);
    });

    await migration.run();

    const args = createdArgs();
    // Docker 与 Node.js 已存在 → 只插入 .NET 与 Aspire
    expect(args.map((arg) => arg.presetKey)).toEqual(['dotnet', 'aspire']);
    // Aspire 的依赖解析到已存在的 Docker / 本次插入的 .NET
    expect(args[1].dependsOnWorkloadIds).toEqual(['existing-docker', 'id-.NET']);
    expect(console.warn).toHaveBeenCalled();
  });

  it('T-MIG4: leaves dependencies empty (with a warning) when a dependency is missing', async () => {
    // Docker 已存在（解析到其 ID）；.NET 创建后 ID 为空（模拟依赖缺失）
    (CloudWorkload.findOne as any).mockImplementation((filter: { presetKey?: string; name?: string }) => {
      if (filter.presetKey === 'docker') return Promise.resolve({ _id: 'existing-docker' });
      return Promise.resolve(null);
    });
    (CloudWorkload.create as any).mockImplementation((doc: { name: string }) =>
      Promise.resolve({ _id: doc.name === '.NET' ? '' : `id-${doc.name}` }),
    );

    await migration.run();

    const aspire = createdArgs().find((arg) => arg.presetKey === 'aspire');
    expect(aspire?.dependsOnWorkloadIds).toEqual(['existing-docker']);
    expect(console.warn).toHaveBeenCalled();
  });
});
