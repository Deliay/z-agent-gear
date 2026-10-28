/**
 * 将 Markdown 源文本转换为「去除标记符号后的可读纯文本」。
 *
 * 复制纯文本必须从源 Markdown 派生，而不是读取渲染后的 DOM：
 * DOM 中混有代码块语言标签、Mermaid 工具栏等 UI chrome（R-13）。
 * 代码块与行内代码先抽成占位符，保证代码内容逐字保留、不被后续标记清理误伤。
 */
export function markdownToPlainText(markdown: string): string {
  if (!markdown) return '';
  let text = markdown.replace(/\r\n?/g, '\n');

  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // 围栏代码块：保留代码正文，去掉围栏行与语言标签（Mermaid 复制源码）
  text = text.replace(
    /^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm,
    (_match, body: string) => `\uE000BLOCK${codeBlocks.push(body.trimEnd()) - 1}\uE001`,
  );
  // 行内代码：内容逐字保留
  text = text.replace(/`([^`]+)`/g, (_match, body: string) => `\uE000INLINE${inlineCodes.push(body) - 1}\uE001`);

  // 图片替换为 alt，链接替换为 label
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // 标题 / 引用 / 列表 / 任务清单标记
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, '');
  text = text.replace(/^[ \t]{0,3}(?:[-*+]|\d+\.)[ \t]+/gm, '');
  text = text.replace(/^\[[ xX]\][ \t]+/gm, '');

  // 表格分隔行与管道符
  text = text.replace(/^[ \t]{0,3}\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/gm, '');
  text = text.replace(/^[ \t]{0,3}\|(.*)\|[ \t]*$/gm, (_match, row: string) => row.replace(/\s*\|\s*/g, ' | ').trim());

  // 强调 / 删除线（下划线形式易误伤 snake_case，只处理星号与双下划线）
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/\*(.*?)\*/g, '$1');
  text = text.replace(/~~(.*?)~~/g, '$1');

  // 分隔线 / 原始 HTML 标签
  text = text.replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, '');
  text = text.replace(/<[^>]+>/g, '');

  text = text.replace(/\uE000BLOCK(\d+)\uE001/g, (_match, index: string) => codeBlocks[Number(index)] ?? '');
  text = text.replace(/\uE000INLINE(\d+)\uE001/g, (_match, index: string) => inlineCodes[Number(index)] ?? '');

  return text.replace(/\n{3,}/g, '\n\n').trim();
}
