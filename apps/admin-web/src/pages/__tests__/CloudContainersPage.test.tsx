import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CloudContainersPage from '@/pages/CloudContainersPage';

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  start: vi.fn(),
  destroy: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  useMutation: (doc: unknown) => {
    const source = String(doc);
    if (source.includes('AdminStartCloudContainer')) return [mocks.start, { loading: false }];
    if (source.includes('AdminDestroyCloudContainer')) return [mocks.destroy, { loading: false }];
    return [vi.fn(), { loading: false }];
  },
}));

function container(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    name: 'zag-worker-abc123',
    status: 'ONLINE',
    purpose: 'IDLE',
    refId: null,
    createdAt: '2026-10-14T10:00:00Z',
    connectedAt: '2026-10-14T10:00:30Z',
    exitedAt: null,
    exitReason: null,
    ...overrides,
  };
}

function setupContainers(
  containers: unknown[],
  controlPlane: Record<string, unknown> = { online: true, message: null },
  extra: Record<string, unknown> = {},
) {
  mocks.useQuery.mockReturnValue({
    data: { adminCloudContainers: containers, adminCloudContainerControlPlane: controlPlane },
    loading: false,
    error: undefined,
    refetch: mocks.refetch,
    ...extra,
  });
}

describe('CloudContainersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-W1: lists container fields and polls every 10s', () => {
    setupContainers([container()]);
    render(<CloudContainersPage />);

    expect(screen.getByText('zag-worker-abc123')).toBeDefined();
    expect(screen.getByText('在线')).toBeDefined();
    expect(screen.getByText('idle')).toBeDefined();
    expect(screen.getByText('-')).toBeDefined(); // 关联对象 idle 为空
    expect(mocks.useQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pollInterval: 10000 }),
    );
  });

  it('T-W1: keeps the list and open dialog across a polling refresh', () => {
    setupContainers([container()]);
    const { rerender } = render(<CloudContainersPage />);

    fireEvent.click(screen.getByRole('button', { name: '启动' }));
    expect(screen.getByText('启动容器')).toBeDefined();

    // 轮询期间 loading=true 但已有 data，不应卸载列表/对话框
    mocks.useQuery.mockReturnValue({
      data: { adminCloudContainers: [container()] },
      loading: true,
    });
    rerender(<CloudContainersPage />);

    expect(screen.getByText('zag-worker-abc123')).toBeDefined();
    expect(screen.getByText('启动容器')).toBeDefined();
    expect(screen.queryByText('加载中...')).toBeNull();
  });

  it('T-W2: start dialog defaults to idle and emits adminStartCloudContainer(IDLE)', async () => {
    setupContainers([]);
    mocks.start.mockResolvedValue({});
    render(<CloudContainersPage />);

    fireEvent.click(screen.getByRole('button', { name: '启动' }));
    expect(screen.getByText('启动容器')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '确认启动' }));

    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({ variables: { purpose: 'IDLE' } }),
      ),
    );
  });

  it('T-W3: destroy requires confirmation before mutating', async () => {
    setupContainers([container()]);
    mocks.destroy.mockResolvedValue({});
    render(<CloudContainersPage />);

    fireEvent.click(screen.getByRole('button', { name: '强制销毁 zag-worker-abc123' }));
    expect(screen.getByText('强制销毁容器')).toBeDefined();
    expect(mocks.destroy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '强制销毁' }));

    await waitFor(() =>
      expect(mocks.destroy).toHaveBeenCalledWith(
        expect.objectContaining({ variables: { id: 'c1' } }),
      ),
    );
  });

  it('T-W4: maps every status badge and computes online duration (verdict 15)', () => {
    setupContainers([
      container({ id: 'c-on', status: 'ONLINE', connectedAt: '2026-10-14T10:00:00Z' }),
      container({
        id: 'c-ex',
        name: 'zag-worker-exited',
        status: 'EXITED',
        connectedAt: '2026-10-14T10:00:00Z',
        exitedAt: '2026-10-14T12:05:00Z',
        exitReason: 'OOMKilled',
      }),
      container({ id: 'c-fail', name: 'zag-worker-failed', status: 'FAILED', connectedAt: null }),
    ]);
    render(<CloudContainersPage />);

    expect(screen.getByText('在线')).toBeDefined();
    expect(screen.getByText('已退出')).toBeDefined();
    expect(screen.getByText('失败')).toBeDefined();
    // exitedAt - connectedAt = 2小时5分
    expect(screen.getByText('2小时5分')).toBeDefined();
    // 未回连 => '-'
    expect(screen.getAllByText('-').length).toBeGreaterThan(0);
  });

  it('T-W5: shows a control-plane offline banner (via contract field) while keeping degraded data', () => {
    setupContainers([container()], { online: false, message: '控制面离线' });
    render(<CloudContainersPage />);

    expect(screen.getByText(/控制面离线/)).toBeDefined();
    expect(screen.getByText('zag-worker-abc123')).toBeDefined();
  });

  it('T-W6: shows empty state with start guidance', () => {
    setupContainers([]);
    render(<CloudContainersPage />);

    expect(screen.getByText('暂无云端容器')).toBeDefined();
    expect(screen.getByRole('button', { name: '启动' })).toBeDefined();
  });

  it('T-W6: renders an error state with retry instead of the empty state', () => {
    mocks.useQuery.mockReturnValue({
      data: undefined,
      loading: false,
      error: new Error('cloudContainers boom'),
      refetch: mocks.refetch,
    });
    render(<CloudContainersPage />);

    expect(screen.getByRole('alert').textContent).toContain('cloudContainers boom');
    expect(screen.queryByText('暂无云端容器')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('T-W6: keeps degraded data (no full-page error) when a poll fails after data loaded', () => {
    mocks.useQuery.mockReturnValue({
      data: {
        adminCloudContainers: [container()],
        adminCloudContainerControlPlane: { online: true, message: null },
      },
      loading: false,
      error: new Error('poll failed'),
      refetch: mocks.refetch,
    });
    render(<CloudContainersPage />);

    expect(screen.getByText('zag-worker-abc123')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
