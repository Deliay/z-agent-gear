import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import ModelSection from '../models/ModelSection';
import CustomModelDialog from '../models/CustomModelDialog';

const dnd = vi.hoisted(() => ({ onDragEnd: null as null | ((event: unknown) => void) }));

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  refetch: vi.fn(),
  toggle: vi.fn(),
  sort: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  useMutation: (doc: unknown) => {
    const source = String(doc);
    if (source.includes('ToggleGlobalModel')) return [mocks.toggle, { loading: false }];
    if (source.includes('SortOrder')) return [mocks.sort, { loading: false }];
    if (source.includes('CreateGlobalCustomModel')) return [mocks.create, { loading: false }];
    if (source.includes('DeleteGlobalCustomModel')) return [mocks.remove, { loading: false }];
    return [vi.fn(), { loading: false }];
  },
}));

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, warning: vi.fn() },
}));

vi.mock('@dnd-kit/core', async () => {
  const React = await import('react');
  return {
    DndContext: ({
      children,
      onDragEnd,
    }: {
      children: React.ReactNode;
      onDragEnd: (event: unknown) => void;
    }) => {
      dnd.onDragEnd = onDragEnd;
      return React.createElement('div', null, children);
    },
    closestCenter: () => {},
    PointerSensor: function PointerSensor() {},
    useSensor: () => ({}),
    useSensors: () => [],
  };
});

vi.mock('@dnd-kit/sortable', async () => {
  const React = await import('react');
  return {
    SortableContext: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', null, children),
    verticalListSortingStrategy: {},
    useSortable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: () => {},
      transform: null,
      transition: null,
      isDragging: false,
    }),
  };
});

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

function model(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    providerId: 'p1',
    provider: { id: 'p1', name: 'My OpenAI', type: 'OpenAI', isEnabled: true, scope: 'global' },
    name: `model-${id}`,
    isCustom: false,
    isEnabled: true,
    sortOrder: 0,
    scope: 'global',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function setupQueries(models: unknown[], providers: unknown[] = []) {
  mocks.useQuery.mockImplementation((doc: unknown) => {
    if (String(doc).includes('adminProviders')) {
      return { data: { adminProviders: providers }, loading: false, error: undefined, refetch: mocks.refetch };
    }
    return { data: { adminModels: models }, loading: false, error: undefined, refetch: mocks.refetch };
  });
}

describe('ModelSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-W2: sends the reordered ids to updateGlobalModelSortOrder on drag end', async () => {
    setupQueries([model('a'), model('b'), model('c')]);
    render(<ModelSection />);

    await act(async () => {
      dnd.onDragEnd?.({ active: { id: 'c' }, over: { id: 'a' } });
    });

    expect(mocks.sort).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { ids: ['c', 'a', 'b'] } }),
    );
  });

  it('T-W2: recomputes ids from the latest list at send time (no stale closure)', async () => {
    let currentModels = [model('a'), model('b'), model('c')];
    mocks.useQuery.mockImplementation((doc: unknown) => {
      if (String(doc).includes('adminProviders')) {
        return { data: { adminProviders: [] }, loading: false, error: undefined, refetch: mocks.refetch };
      }
      return { data: { adminModels: currentModels }, loading: false, error: undefined, refetch: mocks.refetch };
    });

    const { rerender } = render(<ModelSection />);
    // 保存拖拽开始前注册的旧回调，模拟 refetch 后事件仍持有旧闭包
    const staleHandler = dnd.onDragEnd;

    currentModels = [model('a'), model('b'), model('c'), model('d')];
    rerender(<ModelSection />);

    await act(async () => {
      staleHandler?.({ active: { id: 'c' }, over: { id: 'a' } });
    });

    expect(mocks.sort).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { ids: ['c', 'a', 'b', 'd'] } }),
    );
  });

  it('T-W3: only custom models expose a delete button', () => {
    setupQueries([
      model('a'),
      model('b', { isCustom: true, name: 'my-custom' }),
    ]);
    render(<ModelSection />);

    expect(screen.getAllByTitle('删除自定义模型')).toHaveLength(1);
    expect(screen.getByText('my-custom')).toBeDefined();
  });

  it('T-W3: deleting a custom model confirms in a dialog then calls the delete mutation', async () => {
    setupQueries([model('b', { isCustom: true, name: 'my-custom' })]);
    mocks.remove.mockResolvedValue({});
    render(<ModelSection />);

    fireEvent.click(screen.getByTitle('删除自定义模型'));

    expect(screen.getByText('删除自定义模型')).toBeDefined();
    expect(mocks.remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith(
        expect.objectContaining({ variables: { id: 'b' } }),
      ),
    );
  });

  it('T-W3: disables the switch when the parent provider is disabled', () => {
    setupQueries([
      model('a', { provider: { id: 'p1', name: 'Disabled', type: 'OpenAI', isEnabled: false, scope: 'global' } }),
    ]);
    render(<ModelSection />);

    expect(screen.getByRole('switch', { name: '启用 model-a' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByText('供应商已禁用')).toBeDefined();
  });

  it('T-W5: shows empty state when there are no models', () => {
    setupQueries([]);
    render(<ModelSection />);
    expect(screen.getByText('暂无可用模型，添加供应商后自动拉取')).toBeDefined();
  });

  it('T-W5: renders an error state with retry when the models query fails', () => {
    mocks.useQuery.mockImplementation((doc: unknown) => {
      if (String(doc).includes('adminProviders')) {
        return { data: { adminProviders: [] }, loading: false, error: undefined, refetch: mocks.refetch };
      }
      return { data: undefined, loading: false, error: new Error('adminModels boom'), refetch: mocks.refetch };
    });
    render(<ModelSection />);

    expect(screen.getByRole('alert').textContent).toContain('adminModels boom');
    expect(screen.queryByText('暂无可用模型，添加供应商后自动拉取')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(mocks.refetch).toHaveBeenCalled();
  });
});

describe('CustomModelDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-W3: surfaces the duplicate-name error from the mutation', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Model name already exists for this provider'));
    render(
      <CustomModelDialog
        open
        onOpenChange={() => {}}
        providers={[{ id: 'p1', name: 'My OpenAI' }]}
        onSave={onSave}
      />,
    );

    fireEvent.change(screen.getByLabelText('模型名称'), { target: { value: 'gpt-4o' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Model name already exists for this provider',
      ),
    );
  });
});
