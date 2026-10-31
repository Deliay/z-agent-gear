/**
 * 全仓验收扫描（Phase 11 收口；plan §7 验收清单）。
 *
 * 1. `console.(log|error|warn|info|debug|trace)(` 直出统计与硬门禁：
 *    - `servers/{agent-api,controller-api,admin-api,cloud-controller}/src`：命中数为 0；
 *    - `packages/agent-controller/src`：命中必须全部带行内白名单 `// no-console-allow: <原因>`
 *      （CLI 用户可见输出例外，契约 §… D7），未豁免命中数为 0；
 *    - `apps/<agent-web|admin-web>/src`：仅 `src/lib/logger.ts` 可命中（前端日志唯一出口），其余为 0；
 *    - 排除 `src/migrations/`（不允许修改，历史 console 保留——已知偏差，仅统计输出）。
 * 2. `interface Logger` 重复声明清零（repo 内 0 命中）。
 *
 * 与各包 `src/observability/no-console.test.ts`（T-OBS7，单包守卫）互补：本文件是跨包口径的
 * 验收扫描，可独立运行。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

const CONSOLE_RE = /console\.(log|error|warn|info|debug|trace)\s*\(/;
const ALLOW_RE = /\/\/\s*no-console-allow:\s*\S+/;
const LOGGER_IFACE_RE = /interface\s+Logger\b/;

/** 命中数必须为 0 的后端 src（排除 src/migrations/）。 */
const ZERO_HIT_DIRS = [
  'servers/agent-api/src',
  'servers/controller-api/src',
  'servers/admin-api/src',
  'servers/cloud-controller/src',
] as const;

/** CLI 输出例外包：命中必须全部带 `// no-console-allow`。 */
const CLI_EXCEPTION_DIRS = ['packages/agent-controller/src'] as const;

/** 前端包：仅 `src/lib/logger.ts` 允许命中（相对 `<pkg>/src` 的路径）。 */
const FRONTEND_DIRS = ['apps/agent-web/src', 'apps/admin-web/src'] as const;
const FRONTEND_ALLOWED_FILE = ['lib', 'logger.ts'].join(sep);
const FRONTEND_ALLOWED_LABEL = 'src/lib/logger.ts';

/** 纯统计（已知偏差）：migrations 不允许修改，其中的 console 保留。 */
const MIGRATION_DIRS = [
  'servers/agent-api/src/migrations',
  'servers/controller-api/src/migrations',
  'servers/admin-api/src/migrations',
  'servers/cloud-controller/src/migrations',
];

interface Hit {
  file: string;
  line: number;
  text: string;
  allowed: boolean;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'migrations' && entry !== 'node_modules' && entry !== 'dist' && entry !== 'build') {
        walk(full, out);
      }
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

function scanConsole(absDir: string): Hit[] {
  const hits: Hit[] = [];
  for (const file of walk(absDir)) {
    const rel = relative(absDir, file);
    readFileSync(file, 'utf8').split('\n').forEach((text, idx) => {
      if (CONSOLE_RE.test(text)) {
        hits.push({ file: rel, line: idx + 1, text: text.trim(), allowed: ALLOW_RE.test(text) });
      }
    });
  }
  return hits;
}

function formatHits(hits: Hit[]): string {
  return hits.map((h) => `  ${h.file}:${h.line}: ${h.text}`).join('\n');
}

function statLine(label: string, hits: Hit[]): string {
  const allowed = hits.filter((h) => h.allowed).length;
  return `console scan ${label}: ${hits.length} hit(s), ${allowed} whitelisted\n`;
}

describe('全仓验收扫描：console 直出清零（T-OBS7 口径）', () => {
  for (const dir of [...ZERO_HIT_DIRS, ...CLI_EXCEPTION_DIRS]) {
    it(`${dir}: 未豁免 console 直出为 0`, () => {
      const hits = scanConsole(join(repoRoot, dir));
      const violations = hits.filter((h) => !h.allowed);
      process.stdout.write(statLine(dir, hits));
      // 白名单条目统计输出（不静默）
      for (const h of hits.filter((x) => x.allowed)) {
        process.stdout.write(`  whitelisted: ${dir}/${h.file}:${h.line}\n`);
      }
      expect(
        violations,
        violations.length
          ? `${dir} 发现 ${violations.length} 处未豁免 console 直出（应改用 logger）:\n${formatHits(violations)}\n豁免请在行尾标注 // no-console-allow: <原因>`
          : '',
      ).toEqual([]);
      if (dir.startsWith('servers/')) {
        // 后端服务包更严：连豁免命中也不允许（命中数必须为 0）
        expect(hits, `${dir} 命中数应为 0（后端服务包不开放 console 白名单）:\n${formatHits(hits)}`).toEqual([]);
      }
    });
  }

  for (const dir of FRONTEND_DIRS) {
    it(`${dir}: console 仅允许出现在 ${FRONTEND_ALLOWED_LABEL}`, () => {
      const hits = scanConsole(join(repoRoot, dir));
      const violations = hits.filter((h) => h.file !== FRONTEND_ALLOWED_FILE);
      process.stdout.write(statLine(dir, hits));
      expect(
        violations,
        violations.length
          ? `${dir} 发现 ${violations.length} 处 console 直出（前端唯一出口是 ${FRONTEND_ALLOWED_LABEL}）:\n${formatHits(violations)}`
          : '',
      ).toEqual([]);
    });
  }

  it('src/migrations 不允许修改：console 保留为已知偏差（仅统计）', () => {
    let total = 0;
    for (const dir of MIGRATION_DIRS) {
      const abs = join(repoRoot, dir);
      let hits: Hit[] = [];
      try {
        hits = scanConsole(abs);
      } catch {
        continue; // 目录不存在（如 agent-controller 无 migrations）直接跳过
      }
      total += hits.length;
      process.stdout.write(statLine(`${dir}（已知偏差，排除在门禁外）`, hits));
    }
    expect(total).toBeGreaterThanOrEqual(0);
  });
});

describe('全仓验收扫描：interface Logger 重复声明清零', () => {
  it('repo 内 `interface Logger` 命中数为 0', () => {
    const hits: string[] = [];
    const selfPath = fileURLToPath(import.meta.url);
    const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.aspire', 'worktrees']);
    const walkRepo = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (skipDirs.has(entry)) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walkRepo(full);
        } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
          // 本守卫自身必然包含该字样（断言文案），排除自引用
          if (full === selfPath) continue;
          readFileSync(full, 'utf8').split('\n').forEach((text, idx) => {
            if (LOGGER_IFACE_RE.test(text)) {
              hits.push(`${relative(repoRoot, full)}:${idx + 1}: ${text.trim()}`);
            }
          });
        }
      }
    };
    walkRepo(repoRoot);
    process.stdout.write(`interface Logger scan: ${hits.length} hit(s)\n`);
    expect(
      hits,
      hits.length
        ? `发现 ${hits.length} 处 \`interface Logger\` 重复声明（logger 须引用 vendored ObservationLogger 类型）:\n${hits.join('\n')}`
        : '',
    ).toEqual([]);
  });
});
