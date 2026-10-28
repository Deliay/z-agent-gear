import { describe, it, expect } from 'vitest';
import { markdownToPlainText } from '../markdown-plain-text';

describe('markdownToPlainText', () => {
  it('should strip fenced code fences and keep code content unchanged', () => {
    const text = markdownToPlainText('```typescript\nconst a = 1;\nconst b = 2;\n```');

    expect(text).toBe('const a = 1;\nconst b = 2;');
    expect(text).not.toContain('typescript');
    expect(text).not.toContain('```');
  });

  it('should keep mermaid source code without toolbar chrome', () => {
    const text = markdownToPlainText('```mermaid\ngraph TD;\n  A-->B;\n```');

    expect(text).toBe('graph TD;\n  A-->B;');
    expect(text).not.toContain('100%');
  });

  it('should remove headings, emphasis, inline code and link markup', () => {
    const text = markdownToPlainText('## Title\n\n**bold** and *italic* and `code` and [label](https://example.com)');

    expect(text).toBe('Title\n\nbold and italic and code and label');
  });

  it('should remove list, quote and task markers', () => {
    const text = markdownToPlainText('> quote\n\n- item one\n- [x] done\n1. ordered');

    expect(text).toBe('quote\n\nitem one\ndone\nordered');
  });

  it('should keep markdown-like characters inside code blocks verbatim', () => {
    const text = markdownToPlainText('```ts\nconst snake_case = a * b; // **not bold**\n```');

    expect(text).toBe('const snake_case = a * b; // **not bold**');
  });

  it('should keep inline code verbatim', () => {
    const text = markdownToPlainText('see `a * b` and *italic*');

    expect(text).toBe('see a * b and italic');
  });

  it('should not strip underscores from identifiers', () => {
    expect(markdownToPlainText('foo_bar_baz')).toBe('foo_bar_baz');
  });

  it('should keep plain text unchanged', () => {
    expect(markdownToPlainText('hello world')).toBe('hello world');
  });

  it('should return an empty string for empty input', () => {
    expect(markdownToPlainText('')).toBe('');
  });
});
