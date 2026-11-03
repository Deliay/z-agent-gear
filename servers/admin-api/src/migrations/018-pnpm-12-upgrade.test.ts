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
import { HARNESS_OPENCODE_SCRIPT_V2 } from './012-worker-user-scripts.js';
import {
  HARNESS_OPENCODE_SCRIPT_V3,
  HARNESS_KIMI_CODE_SCRIPT_V3,
  HARNESS_DEEPSEEK_SCRIPT_V4,
  PLAYWRIGHT_SCRIPT_V2,
} from './017-workload-pnpm-scripts.js';

const testLog = createTestLogger();
const childSpy = vi
  .spyOn(rootLogger, 'child')
  .mockImplementation((bindings) => testLog.logger.child(bindings));
const migration = await import('./018-pnpm-12-upgrade.js');
childSpy.mockRestore();

interface Doc {
  presetKey: string;
  initScript: string | null;
  markModified: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
}

interface Case {
  presetKey: string;
  name: string;
  oldScripts: string[];
  newScript: string;
}

const CASES: Case[] = [
  {
    presetKey: 'harness-opencode',
    name: 'OpenCode（Harness）',
    oldScripts: [HARNESS_OPENCODE_SCRIPT_V3, HARNESS_OPENCODE_SCRIPT_V2],
    newScript: migration.HARNESS_OPENCODE_SCRIPT_V4,
  },
  {
    presetKey: 'harness-kimi-code',
    name: 'Kimi Code（Harness）',
    oldScripts: [HARNESS_KIMI_CODE_SCRIPT_V3],
    newScript: migration.HARNESS_KIMI_CODE_SCRIPT_V4,
  },
  {
    presetKey: 'harness-deepseek-harness',
    name: 'DeepSeek Harness（Harness）',
    oldScripts: [HARNESS_DEEPSEEK_SCRIPT_V4],
    newScript: migration.HARNESS_DEEPSEEK_SCRIPT_V5,
  },
  {
    presetKey: 'playwright',
    name: 'Playwright',
    oldScripts: [PLAYWRIGHT_SCRIPT_V2],
    newScript: migration.PLAYWRIGHT_SCRIPT_V3,
  },
];

const NEW_SCRIPTS = CASES.map((item) => item.newScript);

function seed(overrides: Record<string, string> = {}): Map<string, Doc> {
  const docs = new Map<string, Doc>();
  for (const item of CASES) {
    docs.set(item.presetKey, {
      presetKey: item.presetKey,
      initScript: overrides[item.presetKey] ?? item.newScript,
      markModified: vi.fn(),
      save: vi.fn().mockResolvedValue(undefined),
    });
  }
  return docs;
}

function finder(docs: Map<string, Doc>) {
  (CloudWorkload.findOne as any).mockImplementation(
    (filter: { presetKey?: string; name?: string }) => {
      const key = filter.presetKey ?? filter.name ?? '';
      const byKey = docs.get(key);
      if (byKey) return Promise.resolve(byKey);
      const byName = [...docs.values()].find((doc) => (doc as any).name === key);
      return Promise.resolve(byName ?? null);
    },
  );
}

function bashSyntaxCheck(script: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'zag-pnpm12-script-'));
  try {
    const file = join(dir, 'script.sh');
    writeFileSync(file, script, 'utf8');
    execFileSync('bash', ['-n', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('migration 018-pnpm-12-upgrade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testLog.reset();
  });

  it('exposes the migration name, pnpm version and the four new scripts', () => {
    expect(migration.name).toBe('018-pnpm-12-upgrade');
    expect(migration.PNPM_VERSION).toBe('12.16.1');
    for (const script of NEW_SCRIPTS) expect(script).toBeTypeOf('string');
  });

  it('T-MIG-PN12-1: 历史脚本字节匹配刷新为 pnpm 12 版本', async () => {
    for (const item of CASES) {
      for (const oldScript of item.oldScripts) {
        const docs = seed({ [item.presetKey]: oldScript });
        finder(docs);

        await migration.run();

        const changed = [...docs.values()].filter((doc) => doc.save.mock.calls.length > 0);
        expect(changed, `${item.presetKey}: ${changed.length} updated`).toHaveLength(1);
        expect(changed[0]!.presetKey).toBe(item.presetKey);
        expect(changed[0]!.initScript).toBe(item.newScript);
        expect(changed[0]!.markModified).toHaveBeenCalledWith('initScript');
      }
    }
  });

  it('T-MIG-PN12-2: 新脚本使用 pnpm 12.16.1 且全局 bin 目录在 PATH 中', () => {
    for (const script of NEW_SCRIPTS) {
      expect(script).toContain('npm install -g "pnpm@12.16.1"');
      expect(script).toContain('export PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"');
      expect(script).not.toContain('pnpm@9.15.9');
      expect(script).not.toContain('Installing pnpm 9.15.9');
      expect(script).not.toContain('export PATH="$PNPM_HOME:$PATH"');
    }
    expect(migration.HARNESS_OPENCODE_SCRIPT_V4).toContain(
      'pnpm add -g "@opencode/cli@${OPENCODE_CLI_VERSION}"',
    );
    expect(migration.HARNESS_DEEPSEEK_SCRIPT_V5).toContain('dsh plugin --profile acp add Deliay/dsh-header-masq');
    expect(migration.PLAYWRIGHT_SCRIPT_V3).toContain('pnpm add -g playwright');
  });

  it('T-MIG-PN12-3: 已是新版本或管理员定制时跳过（幂等且不覆盖）', async () => {
    const custom = '#!/usr/bin/env bash\necho custom\n';
    const docs = seed({ 'harness-opencode': custom });
    finder(docs);

    await migration.run();

    expect(docs.get('harness-opencode')!.initScript).toBe(custom);
    expect(docs.get('harness-opencode')!.save).not.toHaveBeenCalled();
    for (const key of ['harness-kimi-code', 'harness-deepseek-harness', 'playwright']) {
      expect(docs.get(key)!.save).not.toHaveBeenCalled();
    }
    expect(testLog.records.some((record) => record.level === 'warn')).toBe(true);
  });

  it('T-MIG-PN12-4: 首轮刷新、二次 run 无副作用；缺失负载静默跳过', async () => {
    const docs = seed(
      Object.fromEntries(CASES.map((item) => [item.presetKey, item.oldScripts[0]!])),
    );
    finder(docs);

    await migration.run();
    expect([...docs.values()].every((doc) => doc.save.mock.calls.length === 1)).toBe(true);

    testLog.reset();
    await migration.run();
    expect([...docs.values()].every((doc) => doc.save.mock.calls.length === 1)).toBe(true);
    expect(testLog.records.some((record) => record.level === 'warn')).toBe(false);

    finder(new Map());
    await migration.run();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });

  it('T-MIG-PN12-5: 四条新脚本 bash -n 通过', () => {
    for (const script of NEW_SCRIPTS) bashSyntaxCheck(script);
  });
});
