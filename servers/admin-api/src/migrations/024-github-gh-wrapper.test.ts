import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger as rootLogger } from '../observability/logger.js';
import { createTestLogger } from '../observability/testing.js';

vi.mock('../models/cloud-workload.js', () => ({
  CloudWorkload: { findOne: vi.fn(), create: vi.fn() },
}));

import { CloudWorkload } from '../models/cloud-workload.js';
import { GITHUB_INIT_SCRIPT } from './007-preset-github.js';
import { GITHUB_SCRIPT_V2 } from './012-worker-user-scripts.js';

const testLog = createTestLogger();
const childSpy = vi
  .spyOn(rootLogger, 'child')
  .mockImplementation((bindings) => testLog.logger.child(bindings));
const migration = await import('./024-github-gh-wrapper.js');
childSpy.mockRestore();

interface Doc {
  presetKey: string | null;
  name: string;
  initScript: string | null;
  markModified: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
}

function seed(initScript: string | null, opts: { byNameOnly?: boolean } = {}): Doc {
  return {
    presetKey: opts.byNameOnly ? null : 'github',
    name: 'Github',
    initScript,
    markModified: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
  };
}

function finder(doc: Doc | null) {
  (CloudWorkload.findOne as any).mockImplementation(
    (filter: { presetKey?: string; name?: string }) => {
      if (!doc) return Promise.resolve(null);
      if (filter.presetKey && doc.presetKey !== filter.presetKey) return Promise.resolve(null);
      if (filter.name && doc.name !== filter.name) return Promise.resolve(null);
      return Promise.resolve(doc);
    },
  );
}

function bashSyntaxCheck(script: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'zag-gh-wrapper-script-'));
  try {
    const file = join(dir, 'script.sh');
    writeFileSync(file, script, 'utf8');
    execFileSync('bash', ['-n', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('migration 024-github-gh-wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testLog.reset();
  });

  it('T-MIG-GW1: V3 安装脚本与 wrapper 常量满足关键约束', () => {
    expect(migration.name).toBe('024-github-gh-wrapper');
    const script = migration.GITHUB_INIT_SCRIPT_V3;
    const wrapper = migration.GH_WRAPPER_SCRIPT;

    expect(script).toContain('${SUDO} apt-get install -y gh');
    expect(script).toContain('ZAG_GH_WRAPPER_SKIP_TOKEN=1 gh --version');
    expect(script).toContain('command -v gh | grep -qxF "$WRAP_PATH"');

    const lines = wrapper.split('\n');
    expect(lines[0]).toBe('#!/usr/bin/env bash');
    expect(lines[1]).toBe(migration.GH_WRAPPER_MARKER);
    expect(wrapper).toContain('ZAG_GH_WRAPPER_SKIP_TOKEN');
    expect(wrapper).toContain('agent-gear');
    expect(wrapper).toContain('github-token </dev/null');
    expect(wrapper).toContain('exec "$REAL_GH" "$@"');
    expect(wrapper).toContain('ZAG_AGENT_GEAR_BIN');
    expect(wrapper).toContain('/home/worker/.local/share/pnpm/agent-gear');
    expect(wrapper).toContain('exit 127');

    bashSyntaxCheck(script);
    bashSyntaxCheck(wrapper);
    // 安装脚本内嵌的 wrapper 与导出常量逐字一致
    expect(script).toContain(`${wrapper}WRAP`);
  });

  it('T-MIG-GW2: V1 → V3 刷新并 save', async () => {
    const doc = seed(GITHUB_INIT_SCRIPT);
    finder(doc);
    await migration.run();
    expect(doc.initScript).toBe(migration.GITHUB_INIT_SCRIPT_V3);
    expect(doc.markModified).toHaveBeenCalledWith('initScript');
    expect(doc.save).toHaveBeenCalledTimes(1);
  });

  it('T-MIG-GW3: V2 → V3 刷新并 save', async () => {
    const doc = seed(GITHUB_SCRIPT_V2);
    finder(doc);
    await migration.run();
    expect(doc.initScript).toBe(migration.GITHUB_INIT_SCRIPT_V3);
    expect(doc.save).toHaveBeenCalledTimes(1);
  });

  it('T-MIG-GW4: V3 幂等重跑不写入', async () => {
    const doc = seed(migration.GITHUB_INIT_SCRIPT_V3);
    finder(doc);
    await migration.run();
    expect(doc.initScript).toBe(migration.GITHUB_INIT_SCRIPT_V3);
    expect(doc.save).not.toHaveBeenCalled();
  });

  it('T-MIG-GW5: 管理员定制脚本跳过并告警', async () => {
    const doc = seed('#!/usr/bin/env bash\necho custom\n');
    finder(doc);
    await migration.run();
    expect(doc.save).not.toHaveBeenCalled();
    expect(testLog.records.some((record) => record.level === 'warn')).toBe(true);
  });

  it('T-MIG-GW6: 预制工作负载缺失时静默跳过', async () => {
    finder(null);
    await expect(migration.run()).resolves.toBeUndefined();
    expect(CloudWorkload.findOne).toHaveBeenCalled();
  });
});
