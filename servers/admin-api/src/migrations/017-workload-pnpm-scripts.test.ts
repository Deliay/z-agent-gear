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
import {
  HARNESS_OPENCODE_INIT_SCRIPT,
  HARNESS_OPENCODE_INIT_SCRIPT_V1,
} from './006-preset-harness-opencode.js';
import { HARNESS_KIMI_CODE_INIT_SCRIPT } from './009-preset-harness-kimi-code.js';
import {
  HARNESS_DEEPSEEK_INIT_SCRIPT,
  HARNESS_DEEPSEEK_INIT_SCRIPT_V1,
} from './010-preset-harness-deepseek.js';
import {
  HARNESS_KIMI_CODE_SCRIPT_V2,
  HARNESS_OPENCODE_SCRIPT_V2,
  HARNESS_DEEPSEEK_SCRIPT_V2,
} from './012-worker-user-scripts.js';
import { HARNESS_DEEPSEEK_SCRIPT_V3 } from './013-preset-harness-deepseek-header-masq.js';
import { PLAYWRIGHT_SCRIPT_V1 } from './015-preset-playwright.js';

/**
 * 注入 createTestLogger：在被测模块加载前拦截 `logger.child(...)`，迁移日志写入内存 sink，
 * 断言 `records` 的结构化字段（与 013 单测同构）。
 */
const testLog = createTestLogger();
const childSpy = vi
  .spyOn(rootLogger, 'child')
  .mockImplementation((bindings) => testLog.logger.child(bindings));
const migration = await import('./017-workload-pnpm-scripts.js');
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
    oldScripts: [
      HARNESS_OPENCODE_INIT_SCRIPT,
      HARNESS_OPENCODE_INIT_SCRIPT_V1,
      HARNESS_OPENCODE_SCRIPT_V2,
    ],
    newScript: migration.HARNESS_OPENCODE_SCRIPT_V3,
  },
  {
    presetKey: 'harness-kimi-code',
    name: 'Kimi Code（Harness）',
    oldScripts: [HARNESS_KIMI_CODE_INIT_SCRIPT, HARNESS_KIMI_CODE_SCRIPT_V2],
    newScript: migration.HARNESS_KIMI_CODE_SCRIPT_V3,
  },
  {
    presetKey: 'harness-deepseek-harness',
    name: 'DeepSeek Harness（Harness）',
    oldScripts: [
      HARNESS_DEEPSEEK_INIT_SCRIPT_V1,
      HARNESS_DEEPSEEK_INIT_SCRIPT,
      HARNESS_DEEPSEEK_SCRIPT_V2,
      HARNESS_DEEPSEEK_SCRIPT_V3,
    ],
    newScript: migration.HARNESS_DEEPSEEK_SCRIPT_V4,
  },
  {
    presetKey: 'playwright',
    name: 'Playwright',
    oldScripts: [PLAYWRIGHT_SCRIPT_V1],
    newScript: migration.PLAYWRIGHT_SCRIPT_V2,
  },
];

const NEW_SCRIPTS = CASES.map((item) => item.newScript);

/** 构造一份「四条均为新脚本」的库内文档表，可按需覆写某条为历史版本。 */
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

/** findOne：优先 presetKey，其次精确 name。 */
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
  const dir = mkdtempSync(join(tmpdir(), 'zag-pnpm-script-'));
  try {
    const file = join(dir, 'script.sh');
    writeFileSync(file, script, 'utf8');
    execFileSync('bash', ['-n', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('migration 017-workload-pnpm-scripts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testLog.reset();
  });

  it('exposes the migration name, pnpm version and the four new scripts', () => {
    expect(migration.name).toBe('017-workload-pnpm-scripts');
    expect(migration.PNPM_VERSION).toBe('9.15.9');
    for (const script of NEW_SCRIPTS) expect(script).toBeTypeOf('string');
  });

  it('T-MIG-PN1: 历史文本字节匹配刷新为新脚本（四条负载全链）', async () => {
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

  it('T-MIG-PN1: 新脚本含 pnpm add -g + 回退块，版本 pin 与硬校验保留', () => {
    const opencode = migration.HARNESS_OPENCODE_SCRIPT_V3;
    expect(opencode).toContain('pnpm add -g "@opencode/cli@${OPENCODE_CLI_VERSION}"');
    expect(opencode).toContain('npm install -g "pnpm@9.15.9"');
    expect(opencode).toContain('export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"');
    expect(opencode).toContain('OpenCode CLI version mismatch');
    expect(opencode).toContain('ZAG_HARNESS_TYPES=opencode agent-gear harness prepare');
    expect(opencode).toContain('export OPENCODE_CLI_VERSION="${OPENCODE_CLI_VERSION:-2.1.1}"');
    expect(opencode).toContain('${ZAG_DEFAULT_WORKSPACE:-/home/worker/workspace}');

    const kimi = migration.HARNESS_KIMI_CODE_SCRIPT_V3;
    expect(kimi).toContain('pnpm add -g "@moonshot-ai/kimi-code@${KIMI_CODE_CLI_VERSION}"');
    expect(kimi).toContain('export KIMI_CODE_CLI_VERSION="${KIMI_CODE_CLI_VERSION:-2.3.2}"');
    expect(kimi).toContain('Kimi Code CLI version mismatch');

    const deepseek = migration.HARNESS_DEEPSEEK_SCRIPT_V4;
    expect(deepseek).toContain(
      'pnpm add -g "@deepseek-ai/dsh@${DSH_CLI_VERSION}" "@deepseek-ai/dsh-acp-app@${DSH_ACP_APP_VERSION}"',
    );
    expect(deepseek).toContain('dsh plugin --profile acp add Deliay/dsh-header-masq');
    expect(deepseek).toContain('ignore-workspace-root-check=true');
    expect(deepseek).toContain('ZAG_HARNESS_TYPES=deepseek_harness agent-gear harness prepare');

    const playwright = migration.PLAYWRIGHT_SCRIPT_V2;
    expect(playwright).toContain('pnpm add -g playwright');
    expect(playwright).toContain('playwright install chromium');
    expect(playwright).toContain('npm config set registry "$REGISTRY"');
    expect(playwright).toContain("grep -q '^chromium-'");
  });

  it('T-MIG-PN2: 已是新版本跳过（幂等重跑无写入）', async () => {
    const docs = seed();
    finder(docs);

    await migration.run();

    for (const doc of docs.values()) expect(doc.save).not.toHaveBeenCalled();
    expect(testLog.records.some((record) => record.level === 'warn')).toBe(false);
  });

  it('T-MIG-PN3: 管理员定制脚本告警且不覆盖', async () => {
    const custom = '#!/usr/bin/env bash\necho custom\n';
    const docs = seed({ 'harness-opencode': custom });
    finder(docs);

    await migration.run();

    expect(docs.get('harness-opencode')!.initScript).toBe(custom);
    expect(docs.get('harness-opencode')!.save).not.toHaveBeenCalled();
    expect(testLog.records.some((record) => record.level === 'warn')).toBe(true);
  });

  it('T-MIG-PN4: 首轮全部刷新，二次 run 无副作用；缺失负载静默跳过', async () => {
    const overrides: Record<string, string> = {
      'harness-opencode': HARNESS_OPENCODE_SCRIPT_V2,
      'harness-kimi-code': HARNESS_KIMI_CODE_SCRIPT_V2,
      'harness-deepseek-harness': HARNESS_DEEPSEEK_SCRIPT_V3,
      playwright: PLAYWRIGHT_SCRIPT_V1,
    };
    const docs = seed(overrides);
    finder(docs);

    await migration.run();
    expect([...docs.values()].every((doc) => doc.save.mock.calls.length === 1)).toBe(true);

    testLog.reset();
    await migration.run();
    expect([...docs.values()].every((doc) => doc.save.mock.calls.length === 1)).toBe(true);
    expect(testLog.records.some((record) => record.level === 'warn')).toBe(false);

    // 预置项已被删除：不创建、不报错
    finder(new Map());
    await migration.run();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
  });

  it('T-MIG-PN4: 同名但无 presetKey 且无脚本的工作负载告警跳过', async () => {
    const docs = new Map<string, any>([
      ['OpenCode（Harness）', { name: 'OpenCode（Harness）', initScript: null, save: vi.fn() }],
    ]);
    finder(docs);

    await migration.run();

    expect(docs.get('OpenCode（Harness）')!.save).not.toHaveBeenCalled();
    expect(testLog.records.some((record) => record.level === 'warn')).toBe(true);
  });

  it('T-MIG-PN5: 四条新脚本 bash -n 通过', () => {
    for (const script of NEW_SCRIPTS) bashSyntaxCheck(script);
  });

  it('T-MIG-PN5: 不含旧 npm 全局安装形态；DeepSeek V4 无局部 pnpm 引导', () => {
    for (const script of NEW_SCRIPTS) {
      expect(script).not.toContain('npm install -g "@opencode');
      expect(script).not.toContain('npm install -g "@moonshot');
      expect(script).not.toContain('npm install -g "@deepseek');
      expect(script).not.toContain('npm install -g playwright');
      // 仅保留回退块内的 pnpm 自举
      const npmInstalls = script.match(/npm install -g [^\n]*/g) ?? [];
      expect(npmInstalls).toEqual(['npm install -g "pnpm@9.15.9"']);
    }
    // DeepSeek 的「仅 dsh 场景」局部引导已收敛为统一回退块（脚本内只出现一次自举块）
    expect(migration.HARNESS_DEEPSEEK_SCRIPT_V4).not.toContain('PNPM_VERSION_V4');
    expect(
      migration.HARNESS_DEEPSEEK_SCRIPT_V4.match(/command -v pnpm >\/dev\/null 2>&1/g) ?? [],
    ).toHaveLength(1);
  });
});
