#!/usr/bin/env node
/**
 * 单源观测模块 → 5 包 vendored 副本 同步脚本（唯一合法同步方式）。
 *
 * 用法：
 *   node scripts/sync-observability.mjs          # 写入副本（缺失目标目录自动创建）
 *   node scripts/sync-observability.mjs --check  # 只校验不写入（不一致退出码 1）
 *
 * 无第三方依赖（纯 Node ESM）。副本文件头：GENERATED FROM ... — DO NOT EDIT。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(repoRoot, 'packages', 'observability', 'src');

const TARGETS = [
  'servers/admin-api/src/observability',
  'servers/agent-api/src/observability',
  'servers/controller-api/src/observability',
  'servers/cloud-controller/src/observability',
  'packages/agent-controller/src/observability',
];

/** 同步的 7 个文件（D2：副本逐字节全等，无 per-package 定制）。 */
export const OBSERVABILITY_FILES = [
  'http-context.ts',
  'log-context.ts',
  'logger.ts',
  'register.ts',
  'telemetry.ts',
  'testing.ts',
  'trace.ts',
];

export function headerFor(file) {
  return `// GENERATED FROM ${relative(repoRoot, join(sourceDir, file)).replaceAll('\\', '/')} — DO NOT EDIT`;
}

export function vendorContent(file) {
  return `${headerFor(file)}\n\n${readFileSync(join(sourceDir, file), 'utf8')}`;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function main(argv = process.argv.slice(2)) {
  const checkOnly = argv.includes('--check');
  let mismatched = 0;
  for (const file of OBSERVABILITY_FILES) {
    const expected = vendorContent(file);
    const expectedHash = sha256(expected);
    for (const target of TARGETS) {
      const targetPath = join(repoRoot, target, file);
      let actual = null;
      try {
        actual = readFileSync(targetPath, 'utf8');
      } catch {
        actual = null;
      }
      if (actual === expected) continue;
      if (checkOnly) {
        mismatched += 1;
        const actualHash = actual === null ? '(missing)' : sha256(actual);
        process.stdout.write(
          `MISMATCH ${target}/${file}\n  expected ${expectedHash}\n  actual   ${actualHash}\n`,
        );
      } else {
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, expected, 'utf8');
        process.stdout.write(`WROTE ${target}/${file}\n`);
      }
    }
  }
  if (checkOnly) {
    if (mismatched > 0) {
      process.stdout.write(
        `\n${mismatched} vendored file(s) out of sync. Run: node scripts/sync-observability.mjs\n`,
      );
      return 1;
    }
    process.stdout.write(`OK: ${TARGETS.length * OBSERVABILITY_FILES.length} vendored files in sync.\n`);
  }
  return 0;
}

// 仅在直接执行时运行（便于测试 import）
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
