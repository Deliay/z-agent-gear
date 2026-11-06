// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { annotationsToPartText, annotationTitle } from '../annotations-to-part.js';
import type { AnnotationBatch, ReviewComment } from '../types.js';

const codeComment: ReviewComment = {
  id: 'c1',
  anchor: { kind: 'code', filePath: 'src/app.ts', startLine: 12, endLine: 14 },
  body: '这里应该用 readonly 数组',
  createdAt: '2026-11-05T12:00:00Z',
};

const codeComment2: ReviewComment = {
  id: 'c2',
  anchor: { kind: 'code', filePath: 'src/app.ts', startLine: 40, endLine: 40 },
  body: '这个判断在空列表时会误报',
  createdAt: '2026-11-05T12:01:00Z',
};

const htmlComment: ReviewComment = {
  id: 'h1',
  anchor: { kind: 'html', selector: '#main > button', innerHtml: '<span>提交</span>' },
  body: '按钮文案要改',
  createdAt: '2026-11-05T12:02:00Z',
};

const markdownComment: ReviewComment = {
  id: 'm1',
  anchor: { kind: 'markdown', text: 'Hello **world**', startOffset: 9, endOffset: 24 },
  body: '这一段重写',
  createdAt: '2026-11-05T12:03:00Z',
};

describe('annotations-to-part（T-ANN1~5）', () => {
  it('T-ANN1 代码来源组装：L12-L14 区间 + 总体意见收尾', () => {
    const batch: AnnotationBatch = {
      target: { filePath: 'src/app.ts', source: 'code' },
      comments: [codeComment, codeComment2],
      summary: '整体 OK，修完这两点即可',
    };
    const text = annotationsToPartText(batch);
    expect(text).toBe([
      '[内容批注] 共 2 条（src/app.ts）',
      '1. L12-L14：这里应该用 readonly 数组',
      '2. L40：这个判断在空列表时会误报',
      '总体意见：整体 OK，修完这两点即可',
    ].join('\n'));
  });

  it('T-ANN2 HTML 来源：selector + innerHtml 节选', () => {
    const batch: AnnotationBatch = {
      target: { source: 'html' },
      comments: [htmlComment],
    };
    const text = annotationsToPartText(batch);
    expect(text).toContain('1. #main > button（<span>提交</span>）：按钮文案要改');
  });

  it('T-ANN3 innerHtml 超 200 字符截断', () => {
    const long: ReviewComment = {
      ...htmlComment,
      anchor: { kind: 'html', selector: '#x', innerHtml: 'y'.repeat(300) },
    };
    const text = annotationsToPartText({ target: { source: 'html' }, comments: [long] });
    expect(text).toContain(`${'y'.repeat(200)}…`);
  });

  it('T-ANN4 Markdown 来源：原文引用块', () => {
    const text = annotationsToPartText({ target: { source: 'markdown' }, comments: [markdownComment] });
    expect(text).toContain('1. 这一段重写\n> Hello **world**');
  });

  it('T-ANN5 空批注与标题行格式', () => {
    const batch: AnnotationBatch = { target: { filePath: 'a.ts', source: 'code' }, comments: [] };
    expect(annotationTitle(batch)).toBe('[内容批注] 共 0 条（a.ts）');
    expect(annotationsToPartText(batch)).toBe('[内容批注] 共 0 条（a.ts）');
    // summary 空白不产生总体意见行
    expect(annotationsToPartText({ ...batch, summary: '   ' })).toBe('[内容批注] 共 0 条（a.ts）');
  });
});
