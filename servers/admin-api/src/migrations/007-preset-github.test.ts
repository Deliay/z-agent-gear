import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../models/cloud-workload.js', () => ({
  CloudWorkload: { findOne: vi.fn(), create: vi.fn() },
}));

import { CloudWorkload } from '../models/cloud-workload.js';
import * as migration from './007-preset-github';

type CreateArg = {
  name: string;
  initScript: string;
  postScript: null | string;
  paramSchema: Array<Record<string, unknown>>;
  dependsOnWorkloadIds: unknown[];
  presetKey: string;
  isPreset: boolean;
  workloadKind: string;
  harnessType: string | null;
};

function createdArgs(): CreateArg[] {
  return (CloudWorkload.create as any).mock.calls.map((call: unknown[]) => call[0] as CreateArg);
}

describe('migration 007-preset-github', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    (CloudWorkload.findOne as any).mockResolvedValue(null);
    (CloudWorkload.create as any).mockImplementation((doc: { name: string }) =>
      Promise.resolve({ _id: `id-${doc.name}` }),
    );
  });

  it('exposes the migration name', () => {
    expect(migration.name).toBe('007-preset-github');
  });

  it('T-MIG1: 空库执行迁移写入 standard 预制项', async () => {
    await migration.run();

    expect(CloudWorkload.create).toHaveBeenCalledTimes(1);
    expect(createdArgs()[0]).toMatchObject({
      name: 'Github',
      presetKey: 'github',
      workloadKind: 'standard',
      isPreset: true,
      postScript: null,
      dependsOnWorkloadIds: [],
    });
  });

  it('T-MIG2: 重复执行不新增第二条', async () => {
    await migration.run();
    expect(CloudWorkload.create).toHaveBeenCalledTimes(1);

    (CloudWorkload.findOne as any).mockResolvedValue({ _id: 'existing' });
    (CloudWorkload.create as any).mockClear();

    await migration.run();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });

  it('T-MIG3: 同名非预制项已存在时跳过并 warn，不覆盖', async () => {
    const existing = {
      _id: 'existing',
      name: 'Github',
      initScript: 'custom',
      save: vi.fn(),
    };
    (CloudWorkload.findOne as any).mockImplementation(
      (filter: { presetKey?: string; name?: string }) =>
        Promise.resolve(filter.name === 'Github' ? existing : null),
    );

    await migration.run();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
    expect(existing.initScript).toBe('custom');
    expect(existing.save).not.toHaveBeenCalled();
  });

  it('T-MIG4: 同 presetKey 已被管理员改名时跳过，不覆盖', async () => {
    const existing = { _id: 'existing', name: '我的 Github', save: vi.fn() };
    (CloudWorkload.findOne as any).mockImplementation(
      (filter: { presetKey?: string; name?: string }) =>
        Promise.resolve(filter.presetKey === 'github' ? existing : null),
    );

    await migration.run();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
    expect(existing.name).toBe('我的 Github');
    expect(existing.save).not.toHaveBeenCalled();
  });

  it('T-MIG5: 脚本使用内部 apt 源且首行幂等短路，不访问公网 cli.github.com', () => {
    const script = migration.GITHUB_INIT_SCRIPT;
    expect(script).toContain('command -v gh >/dev/null 2>&1');
    expect(script).toContain(
      'https://nexus.internal.fffdan.com/repository/github-cli-apt-proxy/githubcli-archive-keyring.gpg',
    );
    expect(script).toContain(
      'https://nexus.internal.fffdan.com/repository/github-cli-apt-proxy/',
    );
    expect(script).toContain('apt-get update');
    expect(script).toContain('apt-get install -y gh');
    expect(script).not.toContain('cli.github.com');

    const firstCheck = script.indexOf('command -v gh');
    const aptInstall = script.indexOf('apt-get install -y gh');
    expect(firstCheck).toBeGreaterThan(-1);
    expect(firstCheck).toBeLessThan(aptInstall);

    const dir = mkdtempSync(join(tmpdir(), 'zag-mig007-'));
    const file = join(dir, 'github.sh');
    try {
      writeFileSync(file, script);
      expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T-MIG6: 参数 schema 与默认值正确', () => {
    expect(migration.GITHUB_PARAM_SCHEMA).toEqual([
      {
        key: 'repoFullName',
        label: '仓库',
        type: 'text',
        options: [],
        defaultValue: '',
      },
      {
        key: 'targetPath',
        label: 'Clone 目标路径',
        type: 'text',
        options: [],
        defaultValue: '/root/workspaces/{repo}',
      },
    ]);
  });
});
