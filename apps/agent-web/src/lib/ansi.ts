import AnsiToHtml from 'ansi-to-html';

const converter = new AnsiToHtml({
  escapeXML: true,
  fg: '#e5e7eb',
  bg: '#030712',
  newline: false,
});

/** 纯 SGR 序列（参数仅数字/分号/冒号，终结字节 m）——唯一需要保留的展示序列 */
const SGR_SEQUENCE = /\x1b\[[0-9;:]*m/g; // eslint-disable-line no-control-regex
/**
 * OSC 序列（窗口标题、OSC-8 超链接等），以 BEL 或 ST(ESC \) 结尾。
 * 未终结时只裁到行尾/串尾，避免吞掉后续真实输出（R-9 P6）。
 */
const OSC_SEQUENCE = /\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\|(?=\n)|$)/g; // eslint-disable-line no-control-regex
/**
 * DCS / APC / PM 字符串序列，以 ST(ESC \) 或 BEL 结尾。
 * 未终结时只裁到行尾/串尾，绝不跨行吞掉后续输出（R-9 P5）。
 */
const STRING_SEQUENCE = /\x1b[P_^][^\x07\x1b\n]*(?:\x07|\x1b\\|(?=\n)|$)/g; // eslint-disable-line no-control-regex
/**
 * CSI：参数字节 0x30-0x3F（含 < = > ?）、中间字节 0x20-0x2F、终结字节 0x40-0x7E。
 * 终结字节缺失（流式/截断）时只裁到行尾/串尾，避免参数泄漏为正文（R-9 P7）。
 */
const CSI_SEQUENCE = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*(?:[\x40-\x7e]|(?=\n)|$)/g; // eslint-disable-line no-control-regex
/** 字符集切换与键盘模式切换 */
const MISC_ESCAPE = /\x1b[()#][A-Za-z0-9]|\x1b[=>]/g; // eslint-disable-line no-control-regex
/** 其余两字节转义序列 */
const GENERIC_ESCAPE = /\x1b[\x20-\x2f]*[\x30-\x7e]/g; // eslint-disable-line no-control-regex
/** 8-bit C1 CSI（0x9B 引导） */
const C1_CSI = /\x9b[\x30-\x3f]*[\x20-\x2f]*(?:[\x40-\x7e]|(?=\n)|$)/g;

/** 占位符使用私用区字符 + 随机 nonce，正文无法预测/伪造（M-1） */
const PLACEHOLDER_START = '\uE000';
const PLACEHOLDER_END = '\uE001';

/** `\r` 覆盖语义：同一行内只保留最后一次回车之后的内容（进度条类输出不堆叠，M-3） */
function normalizeCarriageReturns(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const lastCarriageReturn = line.lastIndexOf('\r');
      return lastCarriageReturn === -1 ? line : line.slice(lastCarriageReturn + 1);
    })
    .join('\n');
}

/**
 * T.416 冒号参数 SGR（如 `38:2::10:20:30`）归一化为分号参数，
 * 避免 ansi-to-html 不识别子参数而把余量当正文输出（R-9 P8）。
 */
function normalizeSgr(sequence: string): string {
  const body = sequence.slice(2, -1);
  if (!body.includes(':')) return sequence;

  const params = body.split(';').flatMap((param) => {
    if (!param.includes(':')) return [param];
    const subs = param.split(':').filter((part) => part !== '');
    const head = subs[0] ?? '';
    if (head === '38' || head === '48') {
      const mode = subs[1];
      if (mode === '2') {
        // 子参数可能是 `r:g:b` 或 `colorspace:r:g:b`，统一取末尾三通道
        const rgb = subs.length >= 5 ? subs.slice(subs.length - 3) : subs.slice(2);
        return [head, '2', ...rgb];
      }
      if (mode === '5') {
        return [head, '5', subs[subs.length - 1] ?? '0'];
      }
      return [head];
    }
    // 其他带子参数的 SGR（如 4:3 花式下划线）只保留主参数
    return [head];
  });

  return `\x1b[${params.join(';')}m`;
}

/**
 * ANSI 转安全 HTML：保留 SGR 颜色/粗体，剥离其余全部非展示序列
 * （CSI 私有模式/光标/清屏、bracketed paste 标记、DCS/APC/PM、OSC 含 OSC-8、字符集切换等）。
 *
 * 实现方式：先把纯 SGR 序列替换为不可伪造的占位符，再兜底剥离所有 ESC 引导序列
 * （含截断/未终结序列），剔除残留 C0/C1 控制符与 8-bit C1 序列，最后还原归一化后的 SGR。
 * 返回内容已由 ansi-to-html 转义（escapeXML），可直接 dangerouslySetInnerHTML。
 */
export function ansiToHtml(raw: string): string {
  const normalized = normalizeCarriageReturns(raw ?? '');

  const nonce = Math.random().toString(36).slice(2);
  const sgrSequences: string[] = [];
  const withPlaceholders = normalized.replace(SGR_SEQUENCE, (sequence) => {
    const index = sgrSequences.push(normalizeSgr(sequence)) - 1;
    return `${PLACEHOLDER_START}${nonce}:${index}${PLACEHOLDER_END}`;
  });

  const stripped = withPlaceholders
    .replace(OSC_SEQUENCE, '')
    .replace(STRING_SEQUENCE, '')
    .replace(C1_CSI, '')
    .replace(CSI_SEQUENCE, '')
    .replace(MISC_ESCAPE, '')
    .replace(GENERIC_ESCAPE, '')
    .replace(/\x1b/g, '') // eslint-disable-line no-control-regex
    // 残留 C1 控制符（含孤立 ST 0x9C）与 C0 控制符（保留 \t \n）
    .replace(/[\u0080-\u009f]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''); // eslint-disable-line no-control-regex

  const placeholderPattern = new RegExp(
    `${PLACEHOLDER_START}${nonce}:(\\d+)${PLACEHOLDER_END}`,
    'g',
  );
  const restored = stripped.replace(placeholderPattern, (_match, index: string) => (
    sgrSequences[Number(index)] ?? ''
  ));

  return converter.toHtml(restored);
}
