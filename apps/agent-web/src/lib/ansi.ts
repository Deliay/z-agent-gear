import AnsiToHtml from 'ansi-to-html';

const converter = new AnsiToHtml({
  escapeXML: true,
  fg: '#e5e7eb',
  bg: '#030712',
  newline: false,
});

/** 纯 SGR 序列（参数仅数字/分号/冒号，终结字节 m）——唯一需要保留的展示序列 */
const SGR_SEQUENCE = /\x1b\[[0-9;:]*m/g; // eslint-disable-line no-control-regex
/** OSC 序列（窗口标题、OSC-8 超链接等），以 BEL 或 ST(ESC \) 结尾 */
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g; // eslint-disable-line no-control-regex
/** DCS / APC / PM 字符串序列，以 ST(ESC \) 或 BEL 结尾 */
const STRING_SEQUENCE = /\x1b[P_^][\s\S]*?(?:\x1b\\|\x07|$)/g; // eslint-disable-line no-control-regex
/** CSI：参数字节 0x30-0x3F（含 < = > ?）、中间字节 0x20-0x2F、终结字节 0x40-0x7E */
const CSI_SEQUENCE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g; // eslint-disable-line no-control-regex
/** 字符集切换与键盘模式切换 */
const MISC_ESCAPE = /\x1b[()#][A-Za-z0-9]|\x1b[=>]/g; // eslint-disable-line no-control-regex
/** 其余两字节转义序列 */
const GENERIC_ESCAPE = /\x1b[\x20-\x2f]*[\x30-\x7e]/g; // eslint-disable-line no-control-regex
/** 占位符边界字符（正文中不会出现的控制字符） */
const PLACEHOLDER_START = '\u0001SGR';
const PLACEHOLDER_END = '\u0001';
const PLACEHOLDER_PATTERN = /\u0001SGR(\d+)\u0001/g; // eslint-disable-line no-control-regex

/**
 * ANSI 转安全 HTML：保留 SGR 颜色/粗体，剥离其余全部非展示序列
 * （CSI 私有模式/光标/清屏、bracketed paste 标记、DCS/APC/PM、OSC 含 OSC-8、字符集切换等）。
 *
 * 实现方式：先把纯 SGR 序列替换为占位符，再兜底剥离所有 ESC 引导序列，最后还原 SGR。
 * 返回内容已由 ansi-to-html 转义（escapeXML），可直接 dangerouslySetInnerHTML。
 */
export function ansiToHtml(raw: string): string {
  const normalized = (raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const sgrSequences: string[] = [];
  const withPlaceholders = normalized.replace(SGR_SEQUENCE, (sequence) => {
    const index = sgrSequences.push(sequence) - 1;
    return `${PLACEHOLDER_START}${index}${PLACEHOLDER_END}`;
  });

  const stripped = withPlaceholders
    .replace(OSC_SEQUENCE, '')
    .replace(STRING_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(MISC_ESCAPE, '')
    .replace(GENERIC_ESCAPE, '')
    .replace(/\x1b/g, ''); // eslint-disable-line no-control-regex

  const restored = stripped.replace(PLACEHOLDER_PATTERN, (_match, index: string) => (
    sgrSequences[Number(index)] ?? ''
  ));

  return converter.toHtml(restored);
}
