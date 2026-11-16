import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import KnowledgeBaseEditor from '../KnowledgeBaseEditor';
import type { KnowledgeBaseDocumentData } from '@/graphql/knowledge-base';
import {
  readDocumentDraft,
  resetDraftScheduler,
  writeDocumentDraft,
} from '@/lib/knowledge-base-draft';

const mockUseMutation = vi.fn();
const mockMutate = vi.fn();
const mockToastSuccess = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: (...args: unknown[]) => mockToastSuccess(...args), error: vi.fn() },
}));

const DOC: KnowledgeBaseDocumentData = {
  path: '/guides/setup',
  title: '环境搭建',
  tags: ['入门'],
  description: '已保存的描述',
  content: '已保存的内容',
  createdByName: 'alice',
  updatedByName: 'bob',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-02T00:00:00Z',
};

function renderEditor(callbacks: { onCancel?: () => void; onSaved?: (doc: KnowledgeBaseDocumentData) => void } = {}) {
  return render(
    <KnowledgeBaseEditor
      kbId="kb-1"
      path="/guides/setup"
      document={DOC}
      canCreate
      canUpdate
      onCancel={callbacks.onCancel ?? (() => {})}
      onSaved={callbacks.onSaved}
    />,
  );
}

describe('KnowledgeBaseEditor（T-KBW7~8）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetDraftScheduler();
    mockUseMutation.mockReturnValue([mockMutate, { loading: false }]);
    mockMutate.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    resetDraftScheduler();
  });

  it('T-KBW7 分栏实时预览：右侧输入即时反映到左侧 Markdown', () => {
    renderEditor();

    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '新的标题' } });
    fireEvent.change(screen.getByLabelText('内容'), { target: { value: '## 新的内容' } });
    fireEvent.change(screen.getByLabelText('标签'), { target: { value: 'a, b' } });

    const preview = screen.getByTestId('knowledge-base-editor-preview');
    expect(preview).toHaveTextContent('新的标题');
    expect(preview).toHaveTextContent('新的内容');
    expect(preview).toHaveTextContent('a');
    expect(preview).toHaveTextContent('b');
  });

  it('T-KBW8 存在草稿时弹「恢复未保存的内容？」；恢复后载入草稿', () => {
    writeDocumentDraft('kb-1', '/guides/setup', {
      title: '草稿标题',
      tags: ['草稿'],
      description: '草稿描述',
      content: '草稿内容',
    });
    renderEditor();

    expect(screen.getByText('恢复未保存的内容？')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));

    expect(screen.getByLabelText('标题')).toHaveValue('草稿标题');
    expect(screen.getByLabelText('内容')).toHaveValue('草稿内容');
    expect(screen.getByTestId('knowledge-base-editor-preview')).toHaveTextContent('草稿内容');
  });

  it('T-KBW8b 放弃草稿：清除缓存并保留已保存内容', () => {
    writeDocumentDraft('kb-1', '/guides/setup', {
      title: '草稿标题',
      tags: [],
      description: '',
      content: '草稿内容',
    });
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: '放弃' }));

    expect(screen.getByLabelText('标题')).toHaveValue('环境搭建');
    expect(screen.getByLabelText('内容')).toHaveValue('已保存的内容');
    expect(readDocumentDraft('kb-1', '/guides/setup')).toBeNull();
  });

  it('保存既有文档调用 update 并清除草稿', async () => {
    mockMutate.mockResolvedValue({
      data: { updateKnowledgeBaseDocument: { ...DOC, title: '新标题' } },
    });
    const onSaved = vi.fn();
    renderEditor({ onSaved });

    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '新标题' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: {
            knowledgeBaseId: 'kb-1',
            path: '/guides/setup',
            input: {
              title: '新标题',
              tags: ['入门'],
              description: '已保存的描述',
              content: '已保存的内容',
            },
          },
        }),
      );
    });
    await waitFor(() => {
      expect(mockToastSuccess).toHaveBeenCalledWith('文档已保存');
      expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ title: '新标题' }));
    });
    expect(readDocumentDraft('kb-1', '/guides/setup')).toBeNull();
  });

  it('路径尚无文档时保存走 create', async () => {
    mockMutate.mockResolvedValue({
      data: { createKnowledgeBaseDocument: { ...DOC, path: '/a/new', title: '新文档' } },
    });
    render(
      <KnowledgeBaseEditor
        kbId="kb-1"
        path="/a/new"
        document={null}
        canCreate
        canUpdate
        onCancel={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '新文档' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: expect.objectContaining({
            path: '/a/new',
            input: expect.objectContaining({ title: '新文档' }),
          }),
        }),
      );
    });
  });
});
