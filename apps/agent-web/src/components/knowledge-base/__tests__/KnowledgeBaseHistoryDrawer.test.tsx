import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import KnowledgeBaseHistoryDrawer from '../KnowledgeBaseHistoryDrawer';
import type { KnowledgeBaseEventData } from '@/graphql/knowledge-base';

const mockUseQuery = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

const EVENTS: KnowledgeBaseEventData[] = [
  {
    id: 'e-new',
    path: '/a/b',
    op: 'UPDATE',
    fromPath: null,
    title: '最新版本',
    tags: ['v2'],
    description: '最新描述',
    content: '最新内容',
    actorName: 'alice',
    createdAt: '2026-11-03T00:00:00Z',
  },
  {
    id: 'e-old',
    path: '/a/b',
    op: 'DELETE',
    fromPath: null,
    title: '删除前版本',
    tags: [],
    description: '',
    content: '删除前内容',
    actorName: 'bob',
    createdAt: '2026-11-01T00:00:00Z',
  },
];

describe('KnowledgeBaseHistoryDrawer（T-KBW9）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQuery.mockReturnValue({ data: { knowledgeBaseEvents: EVENTS }, loading: false });
  });

  it('版本下拉按时间倒序、默认最新；选择旧版本只读预览（含已删除路径）', () => {
    render(
      <KnowledgeBaseHistoryDrawer open onClose={() => {}} knowledgeBaseId="kb-1" path="/a/b" />,
    );

    const select = screen.getByLabelText('历史版本选择') as HTMLSelectElement;
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toHaveLength(2);
    expect(select.value).toBe('e-new');

    const preview = screen.getByTestId('knowledge-base-history-preview');
    expect(preview).toHaveTextContent('最新版本');
    expect(preview).toHaveTextContent('最新内容');

    fireEvent.change(select, { target: { value: 'e-old' } });
    expect(preview).toHaveTextContent('删除前版本');
    expect(preview).toHaveTextContent('删除前内容');
    // 只读预览：抽屉内无编辑/保存入口
    expect(within(screen.getByTestId('knowledge-base-history-drawer')).queryByRole('textbox')).toBeNull();
  });

  it('MOVE 事件路径位展示 fromPath → path（其余 op 零回归）', () => {
    mockUseQuery.mockReturnValue({
      data: {
        knowledgeBaseEvents: [
          {
            id: 'e-move',
            path: '/b',
            op: 'MOVE',
            fromPath: '/a',
            title: '移动版本',
            tags: [],
            description: '',
            content: '移动前内容',
            actorName: 'carol',
            createdAt: '2026-11-04T00:00:00Z',
          },
          ...EVENTS,
        ],
      },
      loading: false,
    });
    render(
      <KnowledgeBaseHistoryDrawer open onClose={() => {}} knowledgeBaseId="kb-1" path="/b" />,
    );

    const pathLine = screen.getByTestId('knowledge-base-history-path');
    expect(pathLine).toHaveTextContent('/a');
    expect(pathLine).toHaveTextContent('→');
    expect(pathLine).toHaveTextContent('/b');

    // 切回非 MOVE 版本：路径位只展示 path
    const select = screen.getByLabelText('历史版本选择') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'e-new' } });
    expect(screen.getByTestId('knowledge-base-history-path')).toHaveTextContent('/a/b');
    expect(screen.getByTestId('knowledge-base-history-path')).not.toHaveTextContent('→');
  });

  it('无历史时展示空态', () => {
    mockUseQuery.mockReturnValue({ data: { knowledgeBaseEvents: [] }, loading: false });
    render(
      <KnowledgeBaseHistoryDrawer open onClose={() => {}} knowledgeBaseId="kb-1" path="/none" />,
    );
    expect(screen.getByTestId('knowledge-base-history-empty')).toHaveTextContent('暂无历史版本');
  });
});
