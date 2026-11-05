import type { AnnotationBatch, ReviewComment } from './types';

/**
 * 批注 → 文本片段（提案 §5.2 实现点 4）。
 *
 * `AnnotationBatch` 转为 Markdown 形态文本：代码带 `L12-L14`、HTML 带 selector
 * 与 innerHtml 节选（≤200 字符）、Markdown 带原文引用块；总体意见收尾。
 */

const INNER_HTML_EXCERPT_LIMIT = 200;

function formatAnchor(comment: ReviewComment): string {
  const anchor = comment.anchor;
  if (anchor.kind === 'code') {
    const range = anchor.startLine === anchor.endLine
      ? `L${anchor.startLine}`
      : `L${anchor.startLine}-L${anchor.endLine}`;
    return range;
  }
  if (anchor.kind === 'html') {
    const excerpt = anchor.innerHtml.length > INNER_HTML_EXCERPT_LIMIT
      ? `${anchor.innerHtml.slice(0, INNER_HTML_EXCERPT_LIMIT)}…`
      : anchor.innerHtml;
    return `${anchor.selector}${excerpt ? `（${excerpt}）` : ''}`;
  }
  return '';
}

function formatComment(comment: ReviewComment, index: number): string {
  const anchor = comment.anchor;
  const head = `${index}. ${formatAnchor(comment)}${formatAnchor(comment) ? '：' : ''}${comment.body}`;
  if (anchor.kind === 'markdown') {
    const quote = anchor.text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    return `${head}\n${quote}`;
  }
  return head;
}

/** 生成片段标题行：`[内容批注] 共 N 条（<文件>）` */
export function annotationTitle(batch: AnnotationBatch): string {
  const target = batch.target.filePath ?? batch.target.source;
  return `[内容批注] 共 ${batch.comments.length} 条（${target}）`;
}

/** AnnotationBatch → 文本片段（空批注仅回传标题行与总体意见） */
export function annotationsToPartText(batch: AnnotationBatch): string {
  const lines: string[] = [annotationTitle(batch)];
  batch.comments.forEach((comment, index) => {
    lines.push(formatComment(comment, index + 1));
  });
  if (batch.summary && batch.summary.trim() !== '') {
    lines.push(`总体意见：${batch.summary.trim()}`);
  }
  return lines.join('\n');
}
