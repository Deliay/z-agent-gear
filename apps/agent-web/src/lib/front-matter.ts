/**
 * 极简 front matter 拆分（与服务端 `splitRepoFrontMatter` 同规则，跨包不可 import）。
 *
 * 仅当内容以 `---\n` 开头且前 4KiB 内存在闭合 `\n---` 时解析；逐行 `key: value`
 * （键/值 trim，值不含换行）。块非法按「无 front matter」处理（`frontMatter: []`，body=原文）。
 * 返回**全部键值对**（保留原序，含三键以外的自定义键），供预览渲染键值表格。
 */

export interface FrontMatterEntry {
  key: string;
  value: string;
}

export interface FrontMatterSplit {
  frontMatter: FrontMatterEntry[];
  body: string;
}

const FRONT_MATTER_SCAN_BYTES = 4096;

export function splitFrontMatter(content: string): FrontMatterSplit {
  const fallback: FrontMatterSplit = { frontMatter: [], body: content };
  if (typeof content !== 'string' || !content.startsWith('---\n')) return fallback;

  const head = content.slice(0, FRONT_MATTER_SCAN_BYTES);
  const close = head.indexOf('\n---', 3);
  if (close < 0) return fallback;

  const block = head.slice(4, close);
  const frontMatter: FrontMatterEntry[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) return fallback;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (key === '') return fallback;
    frontMatter.push({ key, value });
  }

  let bodyStart = close + 4;
  if (content.startsWith('\r\n', bodyStart)) bodyStart += 2;
  else if (content[bodyStart] === '\n') bodyStart += 1;
  return { frontMatter, body: content.slice(bodyStart) };
}
