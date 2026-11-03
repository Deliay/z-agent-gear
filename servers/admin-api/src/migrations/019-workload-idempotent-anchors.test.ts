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

/** 注入 createTestLogger：断言 warn/info 结构化字段（与 017 单测同构）。 */
const testLog = createTestLogger();
const childSpy = vi
  .spyOn(rootLogger, 'child')
  .mockImplementation((bindings) => testLog.logger.child(bindings));
const migration = await import('./019-workload-idempotent-anchors.js');
childSpy.mockRestore();

const TARGETS = migration.WORKLOAD_IDEMPOTENCY_TARGETS;
const NEW_SCRIPTS = TARGETS.map((target) => target.newScript);

interface Doc {
  presetKey: string | null;
  name: string;
  initScript: string | null;
  markModified: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
}

function seed(overrides: Record<string, string> = {}): Map<string, Doc> {
  const docs = new Map<string, Doc>();
  for (const target of TARGETS) {
    docs.set(target.presetKey, {
      presetKey: target.presetKey,
      name: target.name,
      initScript: overrides[target.presetKey] ?? target.newScript,
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
      const byName = [...docs.values()].find((doc) => doc.name === key);
      return Promise.resolve(byName ?? null);
    },
  );
}

function bashSyntaxCheck(script: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'zag-idempotent-script-'));
  try {
    const file = join(dir, 'script.sh');
    writeFileSync(file, script, 'utf8');
    execFileSync('bash', ['-n', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 每条脚本的结尾硬校验（内容存在且位于最后一次安装之后）。 */
const HARD_CHECKS: Record<string, RegExp> = {
  docker: /docker buildx version/,
  nodejs: /npm config get registry/,
  dotnet: /dotnet --list-sdks/,
  aspire: /aspire --version/,
  github: /gh --version/,
  'harness-opencode': /agent-gear harness prepare/,
  'harness-kimi-code': /Kimi Code CLI version mismatch/,
  'harness-deepseek-harness': /DeepSeek Harness version mismatch/,
  playwright: /grep -q '\^chromium-'/,
  mongodb: /mongod --version/,
};

describe('migration 019-workload-idempotent-anchors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testLog.reset();
  });

  it('暴露迁移名、10 个预制目标与 Node.js V2 新脚本', () => {
    expect(migration.name).toBe('019-workload-idempotent-anchors');
    expect(TARGETS).toHaveLength(10);
    expect(TARGETS.map((target) => target.presetKey)).toEqual([
      'docker',
      'nodejs',
      'dotnet',
      'aspire',
      'github',
      'harness-opencode',
      'harness-kimi-code',
      'harness-deepseek-harness',
      'playwright',
      'mongodb',
    ]);
    expect(migration.NODEJS_SCRIPT_V2).toBeTypeOf('string');
    expect(migration.NODEJS_SCRIPT_V2).not.toBe(
      TARGETS.find((target) => target.presetKey === 'nodejs')!.oldScripts[0],
    );
  });

  it('T-MIG-I1: 已知历史版本字节匹配刷新为新版本（逐目标全链）', async () => {
    for (const target of TARGETS) {
      for (const oldScript of target.oldScripts) {
        const docs = seed({ [target.presetKey]: oldScript });
        finder(docs);

        await migration.run();

        const changed = [...docs.values()].filter((doc) => doc.save.mock.calls.length > 0);
        expect(changed, `${target.presetKey}: ${changed.length} updated`).toHaveLength(1);
        expect(changed[0]!.presetKey).toBe(target.presetKey);
        expect(changed[0]!.initScript).toBe(target.newScript);
        expect(changed[0]!.markModified).toHaveBeenCalledWith('initScript');
      }
    }
  });

  it('T-MIG-I2: 已是最新版本 → 无写入、无告警（幂等重跑）', async () => {
    const docs = seed();
    finder(docs);

    await migration.run();
    await migration.run();

    for (const doc of docs.values()) expect(doc.save).not.toHaveBeenCalled();
    expect(testLog.records.some((record) => record.level === 'warn')).toBe(false);
  });

  it('T-MIG-I2b: 与 018-pnpm-12-upgrade 组合 → 四条脚本标准版本即 018 输出（018→019 不回退、无告警）', async () => {
    const pnpm12 = await import('./018-pnpm-12-upgrade.js');
    const expected: Record<string, string> = {
      'harness-opencode': pnpm12.HARNESS_OPENCODE_SCRIPT_V4,
      'harness-kimi-code': pnpm12.HARNESS_KIMI_CODE_SCRIPT_V4,
      'harness-deepseek-harness': pnpm12.HARNESS_DEEPSEEK_SCRIPT_V5,
      playwright: pnpm12.PLAYWRIGHT_SCRIPT_V3,
    };
    for (const [presetKey, script] of Object.entries(expected)) {
      const target = TARGETS.find((item) => item.presetKey === presetKey)!;
      expect(target.newScript, `${presetKey}: 019 标准版本落后于 018`).toBe(script);
    }

    // 018 已执行（库内为 pnpm 12 版本）后跑 019：全部 no-op 且无告警
    const docs = seed();
    finder(docs);
    await migration.run();
    for (const doc of docs.values()) expect(doc.save).not.toHaveBeenCalled();
    expect(testLog.records.some((record) => record.level === 'warn')).toBe(false);
  });

  it('T-MIG-I3: 管理员定制脚本告警且不覆盖；已删除负载静默跳过', async () => {
    const custom = '#!/usr/bin/env bash\necho custom\n';
    const docs = seed({ 'harness-opencode': custom });
    finder(docs);

    await migration.run();

    expect(docs.get('harness-opencode')!.initScript).toBe(custom);
    expect(docs.get('harness-opencode')!.save).not.toHaveBeenCalled();
    expect(testLog.records.some((record) => record.level === 'warn')).toBe(true);

    // 已删除的预置项：不重建、不报错
    testLog.reset();
    finder(new Map());
    await migration.run();
    expect(CloudWorkload.create).not.toHaveBeenCalled();
    expect(testLog.records.some((record) => record.level === 'warn')).toBe(false);
  });

  it('T-MIG-I3: 同名但无 presetKey 且无脚本的工作负载告警跳过', async () => {
    const docs = new Map<string, any>([
      ['Node.js', { name: 'Node.js', initScript: null, save: vi.fn(), markModified: vi.fn() }],
    ]);
    finder(docs);

    await migration.run();

    expect(docs.get('Node.js')!.save).not.toHaveBeenCalled();
    expect(testLog.records.some((record) => record.level === 'warn')).toBe(true);
  });

  it('T-MIG-I4: 10 条新脚本 bash -n 通过', () => {
    for (const script of NEW_SCRIPTS) bashSyntaxCheck(script);
  });

  it('T-MIG-I4: 每条脚本含开头锚点分支与结尾硬校验', () => {
    for (const target of TARGETS) {
      const script = target.newScript;
      expect(script).toContain('set -euo pipefail');

      // 锚点/幂等判定：位于脚本前 60 行（Docker/Playwright 等预热较长）
      const head = script.split('\n').slice(0, 60).join('\n');
      expect(head, `${target.presetKey}: missing idempotent anchor`).toMatch(
        /幂等|已安装|已就绪|跳过|installed_version|已安装过/,
      );

      // 结尾硬校验：内容存在，且位于最后一次安装命令之后
      const check = HARD_CHECKS[target.presetKey];
      expect(check, `${target.presetKey}: unknown target`).toBeDefined();
      const checkMatch = script.match(check!);
      expect(checkMatch, `${target.presetKey}: missing final hard check`).not.toBeNull();
      const lastInstall = Math.max(
        script.lastIndexOf('npm install -g'),
        script.lastIndexOf('pnpm add -g'),
        script.lastIndexOf('apt-get install'),
        script.lastIndexOf('nvm install'),
      );
      if (lastInstall >= 0) {
        expect(
          script.lastIndexOf(checkMatch![0]),
          `${target.presetKey}: check before install`,
        ).toBeGreaterThan(lastInstall);
      }
    }
  });

  it('T-MIG-I4: 无重复追加形态（安装行只出现一次；marker 块先清后写）', () => {
    for (const target of TARGETS) {
      const lines = target.newScript
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^(npm install -g|pnpm add -g) /.test(line));
      expect(new Set(lines).size, `${target.presetKey}: duplicated install line`).toBe(
        lines.length,
      );
    }

    // Playwright：幂等标记块单次写入 + sed 先清旧块（不重复追加）
    const playwright = TARGETS.find((target) => target.presetKey === 'playwright')!.newScript;
    const sedIndex = playwright.indexOf('sed -i');
    const teeIndex = playwright.indexOf('tee -a "$RC"');
    expect(sedIndex).toBeGreaterThan(0);
    expect(teeIndex).toBeGreaterThan(sedIndex);
    expect(playwright.match(/tee -a "\$RC"/g)).toHaveLength(1);
    // DeepSeek：.npmrc 写入前 grep 判定，避免重复追加
    const deepseek = TARGETS.find((target) => target.presetKey === 'harness-deepseek-harness')!
      .newScript;
    expect(deepseek).toContain("grep -qs '^ignore-workspace-root-check=true$'");
  });

  it('Node.js V2 锚点：已就绪 → 校验后 exit 0，且旧版本收敛逻辑保留', () => {
    const script = migration.NODEJS_SCRIPT_V2;
    expect(script).toContain('幂等锚点');
    expect(script).toContain('exit 0');
    expect(script).toContain('nvm install "$VERSION" --default');
    expect(script).toContain('npm install -g "$pm"');
    expect(script.indexOf('幂等锚点')).toBeLessThan(script.indexOf('nvm install "$VERSION"'));
  });
});
