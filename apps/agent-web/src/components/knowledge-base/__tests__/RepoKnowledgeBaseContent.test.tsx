import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import RepoKnowledgeBaseContent from '../RepoKnowledgeBaseContent';

vi.mock('@/components/session/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown-content">{content}</div>,
}));

describe('RepoKnowledgeBaseContent（T-RKB-WEB7）', () => {
  it('front matter 全部键值逐行渲染为表格，正文经 MarkdownContent', () => {
    const content =
      '---\ntitle: Git 规范\ntags: [git, 规范]\ncustom: 自定义值\n---\n# 正文标题\n\n内容';
    render(
      <RepoKnowledgeBaseContent
        document={{ path: '/git', title: 'Git 规范', content }}
      />,
    );

    const table = screen.getByTestId('repo-kb-front-matter-table');
    expect(table).toBeInTheDocument();
    expect(table.textContent).toContain('title');
    expect(table.textContent).toContain('Git 规范');
    expect(table.textContent).toContain('tags');
    expect(table.textContent).toContain('custom');
    expect(table.textContent).toContain('自定义值');

    const body = screen.getByTestId('markdown-content');
    expect(body.textContent).toContain('# 正文标题');
    expect(body.textContent).not.toContain('---');
  });

  it('无 front matter 不渲染表格，正文为原文', () => {
    render(
      <RepoKnowledgeBaseContent document={{ path: '/a', title: 'A', content: '# 只有正文' }} />,
    );

    expect(screen.queryByTestId('repo-kb-front-matter-table')).not.toBeInTheDocument();
    expect(screen.getByTestId('markdown-content').textContent).toBe('# 只有正文');
  });
});
