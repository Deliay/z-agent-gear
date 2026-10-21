import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../models/cloud-workload.js', () => ({
  CloudWorkload: { findOne: vi.fn(), create: vi.fn() },
}));

import { CloudWorkload } from '../models/cloud-workload.js';
import * as migration from './006-preset-harness-opencode';

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

describe('migration 006-preset-harness-opencode', () => {
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
    expect(migration.name).toBe('006-preset-harness-opencode');
  });

  it('T-MIG5-1: 首次执行写入 harness 预制项（无 post、无参数、无依赖）', async () => {
    await migration.run();

    expect(CloudWorkload.create).toHaveBeenCalledTimes(1);
    const arg = createdArgs()[0];
    expect(arg).toMatchObject({
      name: 'OpenCode（Harness）',
      presetKey: 'harness-opencode',
      workloadKind: 'harness',
      harnessType: 'opencode',
      isPreset: true,
      paramSchema: [],
      postScript: null,
      dependsOnWorkloadIds: [],
    });
    expect(arg.initScript).toContain('agent-gear harness prepare');
  });

  it('T-MIG5-2: 二次执行跳过，不覆盖管理员修改', async () => {
    await migration.run();
    expect(CloudWorkload.create).toHaveBeenCalledTimes(1);

    const existing = {
      _id: 'existing',
      presetKey: 'harness-opencode',
      initScript: '#!/usr/bin/env bash\necho custom\n',
      save: vi.fn(),
    };
    (CloudWorkload.findOne as any).mockResolvedValue(existing);
    (CloudWorkload.create as any).mockClear();

    await migration.run();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
    expect(existing.initScript).toContain('echo custom');
    expect(existing.save).not.toHaveBeenCalled();
  });

  it('T-MIG5-3: presetKey 或同名校验命中即跳过并告警，不重复创建', async () => {
    (CloudWorkload.findOne as any).mockImplementation(
      (filter: { presetKey?: string; name?: string }) =>
        Promise.resolve(
          filter.presetKey === 'harness-opencode' || filter.name === 'OpenCode（Harness）'
            ? { _id: 'existing' }
            : null,
        ),
    );

    await migration.run();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('T-MIG5-4: 脚本语法通过 bash -n，且顺序为 安装 → 版本校验 → mkdir → harness prepare', () => {
    const script = migration.HARNESS_OPENCODE_INIT_SCRIPT;

    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('OPENCODE_CLI_VERSION="${OPENCODE_CLI_VERSION:-2.1.1}"');
    expect(script).toContain('command -v opencode');
    expect(script).toContain('npm install -g "@opencode/cli@${OPENCODE_CLI_VERSION}"');
    expect(script).toContain('opencode --version');
    expect(script).toContain('mkdir -p "${ZAG_DEFAULT_WORKSPACE:-/root/workspace}"');
    expect(script).toContain('agent-gear harness prepare');

    const install = script.indexOf('npm install -g');
    const version = script.lastIndexOf('opencode --version');
    const mkdir = script.indexOf('mkdir -p');
    const prepare = script.indexOf('agent-gear harness prepare');
    expect(install).toBeGreaterThan(-1);
    expect(version).toBeGreaterThan(install);
    expect(mkdir).toBeGreaterThan(version);
    expect(prepare).toBeGreaterThan(mkdir);

    const dir = mkdtempSync(join(tmpdir(), 'zag-mig006-'));
    const file = join(dir, 'opencode-harness.sh');
    try {
      writeFileSync(file, script);
      expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T-MIG5-5/C-5: 已安装时比对版本，不一致（含 v 前缀）强制重装并硬校验', () => {
    const script = migration.HARNESS_OPENCODE_INIT_SCRIPT;

    // 已安装时读取实际版本（去 v 前缀，命令失败视为未安装）
    expect(script).toContain('command -v opencode');
    expect(script).toContain('installed_version="$(opencode --version');
    expect(script).toContain('installed_version="${installed_version#v}"');
    expect(script).toContain('|| installed_version=""');
    // 仅在版本不一致时重装固定版本
    expect(script).toContain('if [ "${installed_version}" != "${OPENCODE_CLI_VERSION}" ]; then');
    expect(script).toContain('npm install -g "@opencode/cli@${OPENCODE_CLI_VERSION}"');
    // 重装后再次硬校验版本（避免装成功但版本仍不符）
    expect(script).toContain('actual_version="$(opencode --version');
    expect(script).toContain('actual_version="${actual_version#v}"');
    expect(script).toContain('if [ "${actual_version}" != "${OPENCODE_CLI_VERSION}" ]; then');
    expect(script).toContain('exit 1');
    // prepare 通过 env 继承期望版本（export），便于 agent-gear 二次校验
    expect(script).toContain('export OPENCODE_CLI_VERSION=');
  });
});
