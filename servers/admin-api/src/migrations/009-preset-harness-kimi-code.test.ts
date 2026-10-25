import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../models/cloud-workload.js', () => ({
  CloudWorkload: { findOne: vi.fn(), create: vi.fn() },
}));

import { CloudWorkload } from '../models/cloud-workload.js';
import * as migration from './009-preset-harness-kimi-code';

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

describe('migration 009-preset-harness-kimi-code', () => {
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
    expect(migration.name).toBe('009-preset-harness-kimi-code');
  });

  it('T-MIG9a-1: 首次执行写入 Kimi Code harness 预制项（无 post、无参数、无依赖）', async () => {
    await migration.run();

    expect(CloudWorkload.create).toHaveBeenCalledTimes(1);
    const arg = createdArgs()[0];
    expect(arg).toMatchObject({
      name: 'Kimi Code（Harness）',
      presetKey: 'harness-kimi-code',
      workloadKind: 'harness',
      harnessType: 'kimi_code',
      isPreset: true,
      paramSchema: [],
      postScript: null,
      dependsOnWorkloadIds: [],
    });
    expect(arg.initScript).not.toContain('agent-gear harness prepare');
  });

  it('T-MIG9a-2: 二次执行跳过，不覆盖管理员修改', async () => {
    await migration.run();
    expect(CloudWorkload.create).toHaveBeenCalledTimes(1);

    const existing = {
      _id: 'existing',
      presetKey: 'harness-kimi-code',
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

  it('T-MIG9a-3: presetKey 或同名校验命中即跳过并告警，不重复创建', async () => {
    (CloudWorkload.findOne as any).mockImplementation(
      (filter: { presetKey?: string; name?: string }) =>
        Promise.resolve(
          filter.presetKey === 'harness-kimi-code' || filter.name === 'Kimi Code（Harness）'
            ? { _id: 'existing' }
            : null,
        ),
    );

    await migration.run();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('T-MIG9a-4: 脚本固定版本 2.3.2 安装 + 版本硬校验 + mkdir，且不含 login/harness prepare', () => {
    const script = migration.HARNESS_KIMI_CODE_INIT_SCRIPT;

    expect(migration.KIMI_CODE_CLI_VERSION).toBe('2.3.2');
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('KIMI_CODE_CLI_VERSION="${KIMI_CODE_CLI_VERSION:-2.3.2}"');
    expect(script).toContain('command -v kimi');
    expect(script).toContain('npm install -g "@moonshot-ai/kimi-code@${KIMI_CODE_CLI_VERSION}"');
    expect(script).toContain('kimi --version');
    expect(script).toContain('mkdir -p "${ZAG_DEFAULT_WORKSPACE:-/root/workspace}"');

    // 登录只在 agent-gear 使用前闸门完成；init 不登录、不注入平台模型配置
    expect(script).not.toContain('kimi login');
    expect(script).not.toContain('agent-gear harness prepare');

    const install = script.indexOf('npm install -g');
    const version = script.lastIndexOf('kimi --version');
    const mkdir = script.indexOf('mkdir -p');
    expect(install).toBeGreaterThan(-1);
    expect(version).toBeGreaterThan(install);
    expect(mkdir).toBeGreaterThan(version);
  });

  it('T-MIG9a-5: 脚本语法通过 bash -n；已安装时比对版本（去 v 前缀）并在不一致时重装', () => {
    const script = migration.HARNESS_KIMI_CODE_INIT_SCRIPT;

    expect(script).toContain('installed_version="$(kimi --version');
    expect(script).toContain('installed_version="${installed_version#v}"');
    expect(script).toContain('|| installed_version=""');
    expect(script).toContain('if [ "${installed_version}" != "${KIMI_CODE_CLI_VERSION}" ]; then');
    expect(script).toContain('actual_version="$(kimi --version');
    expect(script).toContain('actual_version="${actual_version#v}"');
    expect(script).toContain('if [ "${actual_version}" != "${KIMI_CODE_CLI_VERSION}" ]; then');
    expect(script).toContain('exit 1');

    const dir = mkdtempSync(join(tmpdir(), 'zag-mig009-'));
    const file = join(dir, 'kimi-code-harness.sh');
    try {
      writeFileSync(file, script);
      expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
