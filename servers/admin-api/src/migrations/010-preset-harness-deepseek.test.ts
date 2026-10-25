import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../models/cloud-workload.js', () => ({
  CloudWorkload: { findOne: vi.fn(), create: vi.fn() },
}));

import { CloudWorkload } from '../models/cloud-workload.js';
import * as migration from './010-preset-harness-deepseek';

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

describe('migration 010-preset-harness-deepseek', () => {
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
    expect(migration.name).toBe('010-preset-harness-deepseek');
  });

  it('T-MIG10a-1: 首次执行写入 DeepSeek Harness 预制项（双包安装 + 硬校验 + prepare）', async () => {
    await migration.run();

    expect(CloudWorkload.create).toHaveBeenCalledTimes(1);
    const arg = createdArgs()[0];
    expect(arg).toMatchObject({
      name: 'DeepSeek Harness（Harness）',
      presetKey: 'harness-deepseek-harness',
      workloadKind: 'harness',
      harnessType: 'deepseek_harness',
      isPreset: true,
      paramSchema: [],
      postScript: null,
      dependsOnWorkloadIds: [],
    });
    expect(migration.DSH_CLI_VERSION).toBe('0.1.2-alpha.2');
    expect(migration.DSH_ACP_APP_VERSION).toBe('0.1.2-alpha.2');
    expect(arg.initScript).toContain(
      'npm install -g "@deepseek-ai/dsh@${DSH_CLI_VERSION}" "@deepseek-ai/dsh-acp-app@${DSH_ACP_APP_VERSION}"',
    );
    expect(arg.initScript).toContain('dsh --version');
    expect(arg.initScript).toContain('DeepSeek Harness version mismatch');
    expect(arg.initScript).toContain('mkdir -p "${ZAG_DEFAULT_WORKSPACE:-/root/workspace}"');
    expect(arg.initScript).toContain('agent-gear harness prepare');
    expect(arg.initScript).not.toContain('kimi');
  });

  it('init 脚本可被 bash 语法解析', async () => {
    await migration.run();
    const script = createdArgs()[0].initScript;
    const dir = mkdtempSync(join(tmpdir(), 'dsh-init-'));
    const file = join(dir, 'init.sh');
    try {
      writeFileSync(file, script, 'utf-8');
      expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T-MIG10a-2: 二次执行跳过，不覆盖管理员修改', async () => {
    await migration.run();
    expect(CloudWorkload.create).toHaveBeenCalledTimes(1);

    const existing = {
      _id: 'existing',
      presetKey: 'harness-deepseek-harness',
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

  it('T-MIG10b: 精确 name 命中同样跳过', async () => {
    const byName = { _id: 'by-name', name: 'DeepSeek Harness（Harness）', save: vi.fn() };
    (CloudWorkload.findOne as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(byName);

    await migration.run();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
    expect(byName.save).not.toHaveBeenCalled();
  });
});
