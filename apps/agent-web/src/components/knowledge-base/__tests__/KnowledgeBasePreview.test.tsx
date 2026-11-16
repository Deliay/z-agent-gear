import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import KnowledgeBasePreview from '../KnowledgeBasePreview';
import type { KnowledgeBaseData, KnowledgeBaseDocumentData } from '@/graphql/knowledge-base';

function makeKb(overrides: Partial<KnowledgeBaseData['myAccess']> = {}): KnowledgeBaseData {
  return {
    id: 'kb-1',
    name: '开发规范',
    permissionMode: 'FULL_ACCESS',
    global: true,
    myAccess: {
      canRead: true,
      canCreate: true,
      canUpdate: true,
      canDelete: true,
      canManage: true,
      ...overrides,
    },
    createdAt: '',
    updatedAt: '',
  };
}

const DOC: KnowledgeBaseDocumentData = {
  path: '/guides/setup',
  title: '环境搭建',
  tags: ['入门', '规范'],
  description: '新同学的第一份上手指南',
  content: '# 安装\n\n使用 **pnpm** 安装依赖。',
  createdByName: 'alice',
  updatedByName: 'bob',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-02T00:00:00Z',
};

function renderPreview(kb = makeKb(), callbacks = {}) {
  return render(
    <MemoryRouter>
      <KnowledgeBasePreview
        knowledgeBase={kb}
        document={DOC}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onHistory={vi.fn()}
        {...callbacks}
      />
    </MemoryRouter>,
  );
}

describe('KnowledgeBasePreview（T-KBW6）', () => {
  it('依次渲染面包屑/标题/描述/标签/Markdown，并提供编辑/删除/历史入口', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onHistory = vi.fn();
    renderPreview(makeKb(), { onEdit, onDelete, onHistory });

    const breadcrumb = screen.getByTestId('knowledge-base-breadcrumb');
    expect(breadcrumb).toHaveTextContent('根目录');
    expect(breadcrumb).toHaveTextContent('guides');
    expect(breadcrumb).toHaveTextContent('setup');
    // 面包屑链接直接指向对应路径
    expect(screen.getByText('guides').closest('a')).toHaveAttribute(
      'href',
      '/knowledge-bases/kb-1/guides',
    );

    expect(screen.getByTestId('knowledge-base-title')).toHaveTextContent('环境搭建');
    expect(screen.getByTestId('knowledge-base-description')).toHaveTextContent(
      '新同学的第一份上手指南',
    );
    expect(screen.getByTestId('knowledge-base-tags')).toHaveTextContent('入门');
    expect(screen.getByTestId('knowledge-base-content')).toHaveTextContent('使用 pnpm 安装依赖。');
    expect(screen.getByTestId('knowledge-base-preview-global')).toHaveTextContent('全局工作区');

    fireEvent.click(screen.getByRole('button', { name: '编辑文档' }));
    fireEvent.click(screen.getByRole('button', { name: '删除文档' }));
    fireEvent.click(screen.getByRole('button', { name: '历史版本' }));
    expect(onEdit).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalled();
    expect(onHistory).toHaveBeenCalled();
  });

  it('按 myAccess 收敛按钮：只读时无编辑/删除，历史仍可见', () => {
    renderPreview(makeKb({ canCreate: false, canUpdate: false, canDelete: false, canManage: false }));

    expect(screen.queryByRole('button', { name: '编辑文档' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除文档' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '历史版本' })).toBeInTheDocument();
  });

  it('内容限宽靠左（max-w-3xl，不使用居中）且超长内容可断行', () => {
    renderPreview();
    const article = screen.getByTestId('knowledge-base-preview');
    expect(article).toHaveClass('min-w-0');
    const container = article.querySelector('.max-w-3xl');
    expect(container).toBeInTheDocument();
    expect(container).not.toHaveClass('mx-auto');
    expect(screen.getByTestId('knowledge-base-title')).toHaveClass('wrap-anywhere');
  });
});
