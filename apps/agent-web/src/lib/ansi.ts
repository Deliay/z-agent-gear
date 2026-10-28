import AnsiToHtml from 'ansi-to-html';

const converter = new AnsiToHtml({
  escapeXML: true,
  fg: '#e5e7eb',
  bg: '#030712',
  newline: false,
});

/** OSC 序列（窗口标题、超链接等） */
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g; // eslint-disable-line no-control-regex
/** 光标移动、清屏、制表位等非展示控制序列（保留 SGR `m`） */
const NON_DISPLAY_CSI = /\x1b\[[0-9;?]*[ABCDEFGHJKSTfnsu]/g; // eslint-disable-line no-control-regex
/** 字符集切换与键盘模式切换 */
const MISC_ESCAPE = /\x1b[()#][A-Za-z0-9]|\x1b[=>]/g; // eslint-disable-line no-control-regex

/**
 * ANSI 转安全 HTML：保留 SGR 颜色/粗体，剥离光标控制等非展示序列。
 * 返回内容已由 ansi-to-html 转义（escapeXML），可直接 dangerouslySetInnerHTML。
 */
export function ansiToHtml(raw: string): string {
  const normalized = (raw ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(OSC_SEQUENCE, '')
    .replace(NON_DISPLAY_CSI, '')
    .replace(MISC_ESCAPE, '');

  return converter.toHtml(normalized);
}
