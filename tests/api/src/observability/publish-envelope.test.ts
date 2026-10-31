/**
 * T-OBS22 publishJson 封套覆盖巡检（纯静态扫描，可独立运行、不依赖 live 服务）。
 *
 * 断言口径（plan §5 T-OBS22 / contracts/mcp-forward-redis.md §7）：
 * 1. `servers/agent-api/src` 与 `servers/controller-api/src` 全部 `.ts`（排除 `src/migrations/`）
 *    中的直接发布调用 `redis.publish(` / `.publish(` **只**允许出现在封装 helper
 *    `src/middleware/publish.ts` 内 `publishJson((channel, body) => …publish(channel, body), …)`
 *    的回调形态里；helper 之外直接发布数必须为 0；
 * 2. helper 内确实调用了 `publishJson`（防退化：有人把封套旁路掉会立刻红）。
 *
 * 行内豁免：`// publish-envelope-ok: <原因>`（白名单条目统计输出）。
 * 注释行（`//` / `*` / `/*` 开头）不算命中。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** 待巡检的两个发布包（相对 repoRoot）。 */
const PACKAGES = ['servers/agent-api/src', 'servers/controller-api/src'] as const;
/** 唯一允许直接发布的 helper（相对各包 src 根）。 */
const HELPER = ['middleware', 'publish.ts'].join(sep);

/** 直接发布调用：`.publish(`（覆盖 `redis.publish(` / `getRedisClient().publish(` 等）。 */
const PUBLISH_RE = /\.publish\s*\(/;
/** 行内豁免标注。 */
const ALLOW_RE = /\/\/\s*publish-envelope-ok:\s*\S+/;
/** 白名单原因提取（仅用于统计输出）。 */
const AW_ALLOW = /\/\/\s*publish-envelope-ok:\s*(\S+)/;
/** helper 内唯一允许形态：`publishJson((…) => …publish(…)` 同句回调。 */
const CALLBACK_RE = /publishJson\s*\(\s*\([^)]*\)\s*=>[\s\S]*\.publish\s*\(/;

interface Hit {
  file: string;
  line: number;
  text: string;
  kind: 'helper-callback' | 'whitelisted' | 'violation';
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // migrations 不允许修改（历史不可变），不在巡检范围（已知偏差，见回归报告）
      if (entry !== 'migrations' && entry !== 'node_modules' && entry !== 'dist') walk(full, out);
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function scan(srcDir: string): Hit[] {
  const hits: Hit[] = [];
  for (const file of walk(srcDir)) {
    const rel = relative(srcDir, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, idx) => {
      const trimmed = text.trim();
      // 注释行里的示例/说明不算发布点
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (!PUBLISH_RE.test(text)) return;
      let kind: Hit['kind'];
      if (rel === HELPER && CALLBACK_RE.test(text)) {
        kind = 'helper-callback';
      } else if (ALLOW_RE.test(text)) {
        kind = 'whitelisted';
      } else {
        kind = 'violation';
      }
      hits.push({ file: rel, line: idx + 1, text: trimmed, kind });
    });
  }
  return hits;
}

describe('T-OBS22 matcher 自检', () => {
  it('命中 redis.publish( / client.publish(，放过 publishJson 与 helper 调用 publish(', () => {
    expect(PUBLISH_RE.test("getRedisClient().publish('ch', 'body')")).toBe(true);
    expect(PUBLISH_RE.test("redis.publish('ch', 'body')")).toBe(true);
    expect(PUBLISH_RE.test("publishJson((ch, body) => redis.publish(ch, body), 'ch', payload)")).toBe(true);
    expect(PUBLISH_RE.test('publishJson((ch, body) => client.publish(ch, body), channel, payload)')).toBe(true);
    // 无点号的 helper 调用与函数名本身不算直接发布
    expect(PUBLISH_RE.test("publish('ch', payload)")).toBe(false);
    expect(PUBLISH_RE.test('export function publish(')).toBe(false);
    expect(PUBLISH_RE.test("import { publishJson } from '../observability/trace.js'")).toBe(false);
  });

  it('helper 回调形态被识别；旁路形态（publishJson 不在同句）不被放行', () => {
    expect(
      CALLBACK_RE.test(
        'return publishJson((ch, body) => redis.publish(ch, body), channel, payload);',
      ),
    ).toBe(true);
    expect(
      CALLBACK_RE.test(
        'return (await publishJson((ch, body) => getRedisClient().publish(ch, body), channel, payload)) as number;',
      ),
    ).toBe(true);
    // 直接发布（不经 publishJson 回调）→ 不允许
    expect(CALLBACK_RE.test("getRedisClient().publish(ch, body);")).toBe(false);
    // publishJson 在别处调用、publish 仍裸调 → 不允许
    expect(CALLBACK_RE.test('const b = JSON.stringify(payload); redis.publish(ch, b);')).toBe(false);
    expect(ALLOW_RE.test("redis.publish('x'); // publish-envelope-ok: 守卫自测样本")).toBe(true);
    expect(ALLOW_RE.test('const x = 1;')).toBe(false);
  });
});

for (const pkg of PACKAGES) {
  describe(`T-OBS22 ${pkg} 发布点全部经 publishJson 封套`, () => {
    const srcDir = join(repoRoot, pkg);
    const helperPath = join(srcDir, HELPER);

    it('helper 内部确实调用了 publishJson（防退化）', () => {
      const content = readFileSync(helperPath, 'utf8');
      expect(content, `${pkg}/${HELPER} 不存在或不可读`).toContain('publishJson');
      // 必须从 vendored 观测模块引入封套（而不是本地复制一份实现）
      expect(content).toMatch(/import\s*\{[^}]*publishJson[^}]*\}\s*from\s*'[^']*observability\/trace\.js'/);
      // helper 内至少一处 `.publish(` 落在 publishJson 回调里
      const callbackHits = scan(srcDir).filter((h) => h.kind === 'helper-callback');
      expect(callbackHits.length, 'helper 内没有 publishJson 回调形态的发布调用').toBeGreaterThanOrEqual(1);
    });

    it('helper 之外直接发布数为 0（白名单豁免仅行内注释）', () => {
      const hits = scan(srcDir);
      const helperHits = hits.filter((h) => h.kind === 'helper-callback');
      const whitelisted = hits.filter((h) => h.kind === 'whitelisted');
      const violations = hits.filter((h) => h.kind === 'violation');

      process.stdout.write(
        `publish-envelope scan [${pkg}]: ${hits.length} hit(s) — ` +
          `${helperHits.length} helper-callback, ${whitelisted.length} whitelisted` +
          (whitelisted.length
            ? ` (${whitelisted.map((h) => `${h.file}:${h.line} ${h.text.match(AW_ALLOW)?.[1] ?? ''}`).join('; ')})`
            : '') +
          `, ${violations.length} violation(s)\n`,
      );

      const detail = violations.map((h) => `  ${h.file}:${h.line}: ${h.text}`).join('\n');
      expect(
        violations,
        violations.length
          ? `${pkg} 发现 ${violations.length} 处绕过 publishJson 的直接发布（应改用 src/middleware/publish.ts 的 publish helper）:\n${detail}\n确需豁免请在行尾标注 // publish-envelope-ok: <原因>`
          : '',
      ).toEqual([]);
    });
  });
}
