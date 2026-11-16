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
const mockToastError = vi.fn();
const mockNavigate = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

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

function addTag(value: string): void {
  const input = screen.getByLabelText('标签');
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

describe('KnowledgeBaseEditor（T-KBW7~8 / T-KBW-M）', () => {
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
    addTag('a');
    addTag('b');

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

  it('保存既有文档调用 update 并清除草稿（路径未变不带 newPath）', async () => {
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
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('T-KBW-M1 路径修改保存：newPath 传参、草稿旧键清除、导航新路径', async () => {
    mockMutate.mockResolvedValue({
      data: { updateKnowledgeBaseDocument: { ...DOC, path: '/guides/moved' } },
    });
    const onSaved = vi.fn();
    renderEditor({ onSaved });

    fireEvent.change(screen.getByLabelText('路径'), { target: { value: '/guides/moved' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledTimes(1);
    });
    const call = mockMutate.mock.calls[0][0] as {
      variables: Record<string, unknown>;
      refetchQueries: Array<{ query: unknown; variables?: Record<string, unknown> }>;
    };
    expect(call.variables).toMatchObject({
      knowledgeBaseId: 'kb-1',
      path: '/guides/setup',
      newPath: '/guides/moved',
    });
    // refetch 指向新路径（旧路径不主动失效）
    const paths = call.refetchQueries
      .map((entry) => entry.variables?.path)
      .filter((value): value is string => typeof value === 'string');
    expect(paths).toEqual(['/guides/moved', '/guides/moved']);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/knowledge-bases/kb-1/guides/moved');
      expect(onSaved).toHaveBeenCalled();
    });
    expect(readDocumentDraft('kb-1', '/guides/setup')).toBeNull();
  });

  it('T-KBW-M2 路径非法 → 行内错误且不发 mutation', async () => {
    renderEditor();

    fireEvent.change(screen.getByLabelText('路径'), { target: { value: 'guides/moved' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-base-editor-error')).toHaveTextContent('文档路径不合法');
    });
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('T-KBW-M3 创建分支：以编辑后路径 create；占用失败映射中文且保持编辑态', async () => {
    mockMutate.mockResolvedValue({
      data: { createKnowledgeBaseDocument: { ...DOC, path: '/a/other', title: '新文档' } },
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
    fireEvent.change(screen.getByLabelText('路径'), { target: { value: '/a/other' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: expect.objectContaining({ path: '/a/other' }),
        }),
      );
    });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/knowledge-bases/kb-1/a/other');
    });

    // 占用失败：错误映射「该路径已存在文档」，不导航
    mockNavigate.mockClear();
    mockMutate.mockRejectedValueOnce(new Error('knowledge base document already exists'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.getByTestId('knowledge-base-editor-error')).toHaveTextContent(
        '该路径已存在文档',
      );
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('T-KBW-M4 草稿含 editedPath 与 tags：恢复时路径与徽章完整还原', () => {
    writeDocumentDraft('kb-1', '/guides/setup', {
      title: '草稿标题',
      tags: ['x', 'y'],
      description: '',
      content: '草稿内容',
      editedPath: '/guides/target',
    });
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: '恢复' }));

    expect(screen.getByLabelText('路径')).toHaveValue('/guides/target');
    expect(screen.getByRole('button', { name: '删除标签 x' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除标签 y' })).toBeInTheDocument();
  });
});
