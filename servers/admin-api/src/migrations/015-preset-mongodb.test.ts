import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../models/cloud-workload.js', () => ({
  CloudWorkload: { findOne: vi.fn(), create: vi.fn() },
}));

import { CloudWorkload } from '../models/cloud-workload.js';
import * as migration from './015-preset-mongodb';

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

describe('migration 015-preset-mongodb', () => {
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
    expect(migration.name).toBe('015-preset-mongodb');
  });

  it('T-MIG-MDB1: 空库执行迁移写入 standard 预制项（零参数零依赖、init-only）', async () => {
    await migration.run();

    expect(CloudWorkload.create).toHaveBeenCalledTimes(1);
    const arg = createdArgs()[0];
    expect(arg).toMatchObject({
      name: 'MongoDB',
      presetKey: 'mongodb',
      workloadKind: 'standard',
      harnessType: null,
      isPreset: true,
      postScript: null,
      paramSchema: [],
      dependsOnWorkloadIds: [],
    });
    expect(arg.initScript).toBe(migration.MONGODB_INIT_SCRIPT);
  });

  it('T-MIG-MDB2: presetKey 命中时跳过并告警，不覆盖管理员修改', async () => {
    const existing = {
      _id: 'existing',
      presetKey: 'mongodb',
      name: 'MongoDB（我的改名）',
      initScript: '#!/usr/bin/env bash\necho custom\n',
      save: vi.fn(),
    };
    (CloudWorkload.findOne as any).mockImplementation(
      (filter: { presetKey?: string; name?: string }) =>
        Promise.resolve(filter.presetKey === 'mongodb' ? existing : null),
    );

    await migration.run();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
    expect(existing.initScript).toContain('echo custom');
    expect(existing.save).not.toHaveBeenCalled();
  });

  it('T-MIG-MDB3: 仅精确 name 命中（同名非预制项）时跳过，不产生重名项', async () => {
    const existing = {
      _id: 'existing',
      name: 'MongoDB',
      initScript: 'custom',
      save: vi.fn(),
    };
    (CloudWorkload.findOne as any).mockImplementation(
      (filter: { presetKey?: string; name?: string }) =>
        Promise.resolve(filter.name === 'MongoDB' ? existing : null),
    );

    await migration.run();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
    expect(existing.name).toBe('MongoDB');
    expect(existing.initScript).toBe('custom');
    expect(existing.save).not.toHaveBeenCalled();
  });

  it('T-MIG-MDB4: 幂等重跑（第二次命中 presetKey）至多写入一次', async () => {
    await migration.run();
    expect(CloudWorkload.create).toHaveBeenCalledTimes(1);

    (CloudWorkload.findOne as any).mockResolvedValue({ _id: 'id-MongoDB', presetKey: 'mongodb' });
    (CloudWorkload.create as any).mockClear();

    await migration.run();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });

  it('T-MIG-MDB5: 脚本不变量（内网源、幂等锚点、版本硬校验、无实例拉起、bash -n）', () => {
    const script = migration.MONGODB_INIT_SCRIPT;

    // ① bash -n 语法通过
    const dir = mkdtempSync(join(tmpdir(), 'zag-mig015-'));
    const file = join(dir, 'mongodb.sh');
    try {
      writeFileSync(file, script);
      expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // ② 012 sudo 正典形态
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('SUDO=sudo');
    expect(script).toContain('command -v sudo >/dev/null 2>&1 || SUDO=');

    // ③ 幂等锚点在 apt 源写入之前
    const idempotentAnchor = script.indexOf('command -v mongod');
    const keyring = script.indexOf('mongodb-server-8.0.asc');
    expect(idempotentAnchor).toBeGreaterThan(-1);
    expect(keyring).toBeGreaterThan(idempotentAnchor);

    // ④ 需求指定内网 Nexus GPG + apt 源（不回退公网）
    expect(script).toContain(
      'https://nexus.internal.fffdan.com/repository/misc-cache/mongodb/server-8.0.asc',
    );
    expect(script).toContain('https://nexus.internal.fffdan.com/repository/mongodb-apt-proxy');
    expect(script).toContain('${VERSION_CODENAME}/mongodb-org/8.0 multiverse');
    expect(script).toContain('${SUDO} apt-get update');
    expect(script).toContain('${SUDO} apt-get install -y mongodb-org');
    expect(script).not.toMatch(/repo\.mongodb\.org/);

    // ⑤ 安装成功硬校验：结尾 mongod --version
    const install = script.indexOf('apt-get install -y mongodb-org');
    const versionCheck = script.lastIndexOf('mongod --version');
    expect(versionCheck).toBeGreaterThan(install);

    // ⑥ 返工口径锚定：脚本不含任何实例拉起动作 / 服务托管动作
    expect(script).not.toMatch(/--fork|nohup|runuser|systemctl|mongosh/);
  });
});
