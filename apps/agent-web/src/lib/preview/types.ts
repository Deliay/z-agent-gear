/**
 * 会话内容预览批注数据模型（提案 §3.2）。
 *
 * 三类内容组件（CodePreview / HtmlPreview / MarkdownPreview）批注模式的
 * 「确认回传」产物为 `AnnotationBatch`，会话层经 `annotations-to-part.ts`
 * 转为文本片段进入提示词片段区（契约不含结构化批注字段）。
 */

export type ReviewAnchor =
  | { kind: 'code'; filePath: string; startLine: number; endLine: number }
  | { kind: 'html'; selector: string; innerHtml: string }
  | { kind: 'markdown'; text: string; startOffset: number; endOffset: number };

export interface ReviewComment {
  id: string;
  anchor: ReviewAnchor;
  body: string;
  createdAt: string;
}

export interface AnnotationBatch {
  target: { filePath?: string; source: 'code' | 'html' | 'markdown' | 'review' };
  comments: ReviewComment[];
  summary?: string;
}
