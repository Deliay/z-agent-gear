/**
 * T-OBS8 vendor 一致性：5 包 7 文件与单源（packages/observability/src）内容全等
 * （仅差 `GENERATED ... — DO NOT EDIT` 文件头），文件头必须存在。
 * T-OBS21 同步脚本幂等：`sync-observability.mjs --check` 重复运行输出一致、退出码 0。
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const sourceDir = join(repoRoot, 'packages', 'observability', 'src');

const FILES = [
  'http-context.ts',
  'log-context.ts',
  'logger.ts',
  'register.ts',
  'telemetry.ts',
  'testing.ts',
  'trace.ts',
];

const TARGETS = [
  'servers/admin-api/src/observability',
  'servers/agent-api/src/observability',
  'servers/controller-api/src/observability',
  'servers/cloud-controller/src/observability',
  'packages/agent-controller/src/observability',
];

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('T-OBS8 vendor 一致性', () => {
  it('5 包 7 文件与单源全等且文件头 DO NOT EDIT', () => {
    const mismatches: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(join(sourceDir, file), 'utf8');
      const sourceHash = sha256(source);
      for (const target of TARGETS) {
        const path = join(repoRoot, target, file);
        let content: string;
        try {
          content = readFileSync(path, 'utf8');
        } catch {
          mismatches.push(`missing: ${target}/${file}`);
          continue;
        }
        const header = `// GENERATED FROM packages/observability/src/${file} — DO NOT EDIT`;
        const [firstLine, ...rest] = content.split('\n');
        if (firstLine.trim() !== header) {
          mismatches.push(`bad header: ${target}/${file}`);
          continue;
        }
        // 去掉文件头后的空行 + 正文，与单源比对
        const body = rest.join('\n').replace(/^\n/, '');
        if (sha256(body) !== sourceHash) {
          mismatches.push(`content drift: ${target}/${file}`);
        }
      }
    }
    expect(mismatches, `vendored 副本与单源不一致，请运行 node scripts/sync-observability.mjs：\n${mismatches.join('\n')}`).toEqual([]);
  });
});

describe('T-OBS21 同步脚本幂等', () => {
  it('--check 重复运行输出一致且退出码 0', () => {
    const run = (): string =>
      execFileSync('node', ['scripts/sync-observability.mjs', '--check'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
    const out1 = run();
    const out2 = run();
    expect(out2).toBe(out1);
    expect(out1).toContain('in sync');
  });
});
