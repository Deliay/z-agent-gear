/**
 * no-console 不变量守卫（T-OBS7）：递归扫描本包 `src` 目录下全部 `.ts` 文件（含测试文件），
 * 命中 `console.<level>(` 即失败并输出 `文件:行号` 与正确写法。
 *
 * 行内白名单：`// no-console-allow: <原因>`（守卫输出白名单条目统计）。
 * 例外口径见 contracts/observability.md / plan §3.1 D7。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONSOLE_RE = /console\.(log|error|warn|info|debug|trace)\(/;
const ALLOW_RE = /\/\/\s*no-console-allow:\s*\S+/;

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
      // migration 目录不允许修改（历史不可变），其中的 console 不在守卫范围
      if (entry !== 'migrations') walk(full, out);
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function scan(srcDir: string): Hit[] {
  const hits: Hit[] = [];
  for (const file of walk(srcDir)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, idx) => {
      if (CONSOLE_RE.test(text)) {
        hits.push({ file: relative(srcDir, file), line: idx + 1, text: text.trim(), allowed: ALLOW_RE.test(text) });
      }
    });
  }
  return hits;
}

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('no-console invariant (T-OBS7)', () => {
  it('matcher: 命中直出调用、放过 spyOn 与字符串拼接样本', () => {
    const violation = 'con' + "sole.log('x')";
    const spy = 'vi.spyOn(con' + "sole, 'log')";
    expect(CONSOLE_RE.test(violation)).toBe(true);
    expect(CONSOLE_RE.test(spy)).toBe(false);
    expect(CONSOLE_RE.test('logger.info({ a: 1 }, ' + "'ok')")).toBe(false);
  });

  it('matcher: 行内白名单标注被识别', () => {
    const whitelisted = 'con' + "sole.log('x'); // no-console-allow: 守卫自测样本";
    expect(ALLOW_RE.test(whitelisted)).toBe(true);
    expect(ALLOW_RE.test('const x = 1;')).toBe(false);
  });

  it('本包 src 内无未豁免的 console 直出调用', () => {
    const hits = scan(srcDir);
    const allowed = hits.filter((h) => h.allowed);
    const violations = hits.filter((h) => !h.allowed);
    process.stdout.write(
      `no-console scan: ${hits.length} hit(s), ${allowed.length} whitelisted` +
        (allowed.length
          ? ` (${allowed.map((h) => `${h.file}:${h.line}`).join(', ')})`
          : '') +
        '\n',
    );
    const detail = violations
      .map((h) => `  ${h.file}:${h.line}: ${h.text}`)
      .join('\n');
    expect(
      violations,
      violations.length
        ? `发现 ${violations.length} 处 console 直出（应改用 logger，见 contracts/observability.md）:\n${detail}\n豁免请在行尾标注 // no-console-allow: <原因>`
        : '',
    ).toEqual([]);
  });
});
