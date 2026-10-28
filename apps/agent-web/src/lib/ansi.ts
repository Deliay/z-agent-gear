import AnsiToHtml from 'ansi-to-html';

const converter = new AnsiToHtml({
  escapeXML: true,
  fg: '#e5e7eb',
  bg: '#030712',
  newline: false,
});

/** OSC 序列（窗口标题、超链接等） */
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g; // eslint-disable-line no-control-regex
/** 字符集切换与键盘模式切换 */
const MISC_ESCAPE = /\x1b[()#][A-Za-z0-9]|\x1b[=>]/g; // eslint-disable-line no-control-regex
/** CSI 序列（含私有模式 ?25l/?2004h 等与中间字节）；仅保留 SGR（final byte = m） */
const CSI_SEQUENCE = /\x1b\[([0-9;:?]*)([\x20-\x2f]*)([a-zA-Z])/g; // eslint-disable-line no-control-regex

/**
 * ANSI 转安全 HTML：保留 SGR 颜色/粗体，剥离光标控制/私有模式等非展示序列。
 * 返回内容已由 ansi-to-html 转义（escapeXML），可直接 dangerouslySetInnerHTML。
 */
export function ansiToHtml(raw: string): string {
  const normalized = (raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(OSC_SEQUENCE, '')
    .replace(MISC_ESCAPE, '')
    // CSI 兜底：保留颜色/样式（m），其余（光标移动、清屏、私有模式、bracketed paste 等）全部剥离
    .replace(CSI_SEQUENCE, (sequence) => (sequence.endsWith('m') ? sequence : ''));

  return converter.toHtml(normalized);
}
