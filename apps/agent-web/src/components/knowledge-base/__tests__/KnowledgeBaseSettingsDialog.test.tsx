import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import KnowledgeBaseSettingsDialog from '../KnowledgeBaseSettingsDialog';
import type { KnowledgeBaseData, KnowledgeBaseEventData } from '@/graphql/knowledge-base';

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();
const mockMutate = vi.fn();
const mockToastSuccess = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: (...args: unknown[]) => mockToastSuccess(...args), error: vi.fn() },
}));

const EVENTS: KnowledgeBaseEventData[] = [
  {
    id: 'e1',
    path: '/a',
    op: 'CREATE',
    title: 'A',
    tags: [],
    description: '',
    content: '',
    actorName: 'alice',
    createdAt: '2026-11-03T00:00:00Z',
  },
  {
    id: 'e2',
    path: '/b',
    op: 'UPDATE',
    title: 'B',
    tags: [],
    description: '',
    content: '',
    actorName: 'bob',
    createdAt: '2026-11-02T00:00:00Z',
  },
];

function makeKb(overrides: Partial<KnowledgeBaseData['myAccess']> = {}): KnowledgeBaseData {
  return {
    id: 'kb-1',
    name: '开发规范',
    permissionMode: 'READ_ONLY',
    global: false,
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

describe('KnowledgeBaseSettingsDialog（T-KBW10）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockReturnValue({ data: { knowledgeBaseEvents: EVENTS }, loading: false });
    mockUseMutation.mockReturnValue([mockMutate, { loading: false }]);
    mockMutate.mockResolvedValue({ data: {} });
  });

  it('重命名 / 权限四档 / 全库历史 / 删除二次确认', async () => {
    const onDeleted = vi.fn();
    render(
      <KnowledgeBaseSettingsDialog
        open
        knowledgeBase={makeKb()}
        onClose={() => {}}
        onDeleted={onDeleted}
      />,
    );

    // 全库历史时间倒序（服务端顺序原样展示）
    const events = screen.getAllByTestId('knowledge-base-event');
    expect(events).toHaveLength(2);
    expect(events[0]).toHaveTextContent('/a');
    expect(events[0]).toHaveTextContent('创建');

    // 重命名
    fireEvent.change(screen.getByLabelText('新的知识库名称'), { target: { value: '新名字' } });
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }));
    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({ variables: { id: 'kb-1', name: '新名字' } }),
      );
    });

    // 权限四档
    fireEvent.click(screen.getByRole('radio', { name: /FULL_ACCESS/ }));
    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: { id: 'kb-1', permissionMode: 'FULL_ACCESS' },
        }),
      );
    });

    // 删除二次确认
    fireEvent.click(screen.getByRole('button', { name: '删除知识库' }));
    const confirm = await screen.findByRole('dialog', { name: /删除知识库「新名字」？/ });
    fireEvent.click(within(confirm).getByRole('button', { name: '删除' }));

    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({ variables: { id: 'kb-1' } }),
      );
      expect(onDeleted).toHaveBeenCalled();
    });
  });

  it('非管理员仅查看全库历史（无重命名/权限/删除入口）', () => {
    render(
      <KnowledgeBaseSettingsDialog
        open
        knowledgeBase={makeKb({ canManage: false, canCreate: false, canUpdate: false, canDelete: false })}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByLabelText('新的知识库名称')).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: '权限模式' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除知识库' })).not.toBeInTheDocument();
    expect(screen.getAllByTestId('knowledge-base-event')).toHaveLength(2);
  });
});
