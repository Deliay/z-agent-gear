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
    workloads: [],
    currentWorkloadName: null,
    ...overrides,
  };
}

function workload(id: string, name: string) {
  return {
    id,
    name,
    initScript: `echo ${name}`,
    postScript: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

function workloadLog(overrides: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    containerId: 'c1',
    workloadId: 'w1',
    workloadName: 'setup-node',
    phase: 'INIT',
    status: 'SUCCESS',
    script: 'echo "hello"',
    exitCode: 0,
    log: 'hello\n',
    startedAt: '2026-10-14T10:00:35Z',
    finishedAt: '2026-10-14T10:00:40Z',
    ...overrides,
  };
}

interface SetupOptions {
  containers?: unknown[];
  controlPlane?: { online: boolean; message: string | null };
  workloads?: unknown[];
  logs?: unknown[];
  /** 工作负载查询首次加载失败文案（模拟控制面不可达等）。 */
  workloadsError?: string;
  /** 工作负载查询首次加载中。 */
  workloadsLoading?: boolean;
}

// 按查询文档分派响应（页面同时发起容器/工作负载/日志三类查询）
function setupData(opts: SetupOptions = {}) {
  const containers = opts.containers ?? [];
  const controlPlane = opts.controlPlane ?? { online: true, message: null };
  const workloads = opts.workloads ?? [];
  const logs = opts.logs ?? [];
  mocks.useQuery.mockImplementation((doc: unknown) => {
    const source = String(doc);
    if (source.includes('AdminCloudContainerWorkloadLogs')) {
      return {
        data: { adminCloudContainerWorkloadLogs: logs },
        loading: false,
        error: undefined,
        refetch: mocks.refetch,
      };
    }
    if (source.includes('AdminCloudWorkloads')) {
      if (opts.workloadsLoading) {
        return { data: undefined, loading: true, error: undefined, refetch: mocks.refetch };
      }
      if (opts.workloadsError) {
        return {
          data: undefined,
          loading: false,
          error: new Error(opts.workloadsError),
          refetch: mocks.refetch,
        };
      }
      return {
        data: { adminCloudWorkloads: workloads },
        loading: false,
        error: undefined,
        refetch: mocks.refetch,
      };
    }
    return {
      data: { adminCloudContainers: containers, adminCloudContainerControlPlane: controlPlane },
      loading: false,
      error: undefined,
      refetch: mocks.refetch,
    };
  });
}

function setupContainers(
  containers: unknown[],
  controlPlane: Record<string, unknown> = { online: true, message: null },
) {
  mocks.useQuery.mockReturnValue({
    data: { adminCloudContainers: containers, adminCloudContainerControlPlane: controlPlane },
    loading: false,
    error: undefined,
    refetch: mocks.refetch,
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
    expect(screen.getAllByText('-').length).toBeGreaterThan(0); // 关联对象/工作负载为空
    expect(mocks.useQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pollInterval: 10000 }),
    );
  });

  it('T-W1: keeps the list and open dialog across a polling refresh', () => {
    setupData({ containers: [container()] });
    const { rerender } = render(<CloudContainersPage />);

    fireEvent.click(screen.getByRole('button', { name: '启动' }));
    expect(screen.getByText('启动容器')).toBeDefined();

    // 轮询期间 loading=true 但已有 data，不应卸载列表/对话框
    mocks.useQuery.mockImplementation((doc: unknown) => {
      const source = String(doc);
      if (source.includes('AdminCloudContainerWorkloadLogs')) return { data: undefined, loading: true };
      if (source.includes('AdminCloudWorkloads')) return { data: undefined, loading: true };
      return { data: { adminCloudContainers: [container()] }, loading: true };
    });
    rerender(<CloudContainersPage />);

    expect(screen.getByText('zag-worker-abc123')).toBeDefined();
    expect(screen.getByText('启动容器')).toBeDefined();
    // 页面级加载分支未被触发（列表仍在，未回落到空态）
    expect(screen.queryByText('暂无云端容器')).toBeNull();
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
        expect.objectContaining({ variables: { purpose: 'IDLE', workloadIds: [] } }),
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

  it('T-FW4: multi-selects workloads preserving chosen order and submits ids', async () => {
    setupData({
      containers: [],
      workloads: [workload('w1', 'load-a'), workload('w2', 'load-b')],
    });
    mocks.start.mockResolvedValue({});
    render(<CloudContainersPage />);

    fireEvent.click(screen.getByRole('button', { name: '启动' }));

    const a = screen.getByRole('checkbox', { name: 'load-a' });
    const b = screen.getByRole('checkbox', { name: 'load-b' });
    // 默认不选
    expect(a).not.toBeChecked();
    expect(b).not.toBeChecked();

    fireEvent.click(b);
    fireEvent.click(a);
    expect(b).toBeChecked();
    expect(a).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: '确认启动' }));

    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({ variables: { purpose: 'IDLE', workloadIds: ['w2', 'w1'] } }),
      ),
    );
  });

  it('T-FW4: closing the dialog without confirming does not start', () => {
    setupData({ containers: [], workloads: [workload('w1', 'load-a')] });
    render(<CloudContainersPage />);

    fireEvent.click(screen.getByRole('button', { name: '启动' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'load-a' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('T-FW4: shows an empty hint when no workloads are available', () => {
    setupData({ containers: [], workloads: [] });
    render(<CloudContainersPage />);

    fireEvent.click(screen.getByRole('button', { name: '启动' }));
    expect(screen.getByText('暂无可用工作负载')).toBeDefined();
  });

  it('T-FW4: surfaces a workloads load error with retry instead of an empty hint', () => {
    setupData({ containers: [], workloadsError: 'workloads boom' });
    render(<CloudContainersPage />);

    fireEvent.click(screen.getByRole('button', { name: '启动' }));
    // 查询失败必须提示错误，而不是伪装成「暂无可用工作负载」（否则管理员会漏挂载）
    expect(screen.getByRole('alert').textContent).toContain('workloads boom');
    expect(screen.queryByText('暂无可用工作负载')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('T-FW4: shows a loading hint while the workloads query is in flight', () => {
    setupData({ containers: [], workloadsLoading: true });
    render(<CloudContainersPage />);

    fireEvent.click(screen.getByRole('button', { name: '启动' }));
    expect(screen.getByText('加载中...')).toBeDefined();
    expect(screen.queryByText('暂无可用工作负载')).toBeNull();
  });

  it('T-FW4: caps workload selection at the contract limit (10)', () => {
    const many = Array.from({ length: 12 }, (_, i) => workload(`w${i}`, `load-${i}`));
    setupData({ containers: [], workloads: many });
    render(<CloudContainersPage />);

    fireEvent.click(screen.getByRole('button', { name: '启动' }));
    for (let i = 0; i < 10; i += 1) {
      fireEvent.click(screen.getByRole('checkbox', { name: `load-${i}` }));
    }

    // 已达上限：未选项禁用且点击不生效，已选项仍可取消
    const extra = screen.getByRole('checkbox', { name: 'load-10' });
    expect(extra).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(extra);
    expect(extra).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'load-0' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('T-FW5: shows the initializing badge with the current workload name', () => {
    setupData({
      containers: [
        container({ status: 'INITIALIZING', connectedAt: null, currentWorkloadName: 'setup-node' }),
      ],
    });
    render(<CloudContainersPage />);

    expect(screen.getByText('初始化中')).toBeDefined();
    expect(screen.getByText('setup-node')).toBeDefined();
  });

  it('T-FW6: shows mounted workload names and a placeholder when none', () => {
    setupData({
      containers: [
        container({
          workloads: [workload('w1', 'setup-node'), workload('w2', 'install-deps')],
        }),
        container({ id: 'c2', name: 'zag-worker-two', workloads: [] }),
      ],
    });
    render(<CloudContainersPage />);

    expect(screen.getByText('setup-node')).toBeDefined();
    expect(screen.getByText('install-deps')).toBeDefined();
    expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(2);
  });

  it('T-FW7: opens the workload logs dialog showing snapshot and output without overflow', () => {
    setupData({
      containers: [container()],
      logs: [workloadLog()],
    });
    render(<CloudContainersPage />);

    fireEvent.click(screen.getByRole('button', { name: '工作负载日志 zag-worker-abc123' }));

    expect(screen.getByText('工作负载执行日志')).toBeDefined();
    // 记录列表：工作负载/阶段/状态
    expect(screen.getByText('setup-node')).toBeDefined();
    expect(screen.getByText('初始化')).toBeDefined();
    expect(screen.getByText('成功')).toBeDefined();

    // 选中项：脚本快照与输出日志
    const script = screen.getByText('echo "hello"');
    expect(script.className).toContain('whitespace-pre-wrap');
    expect(script.className).toContain('break-all');
    expect(script.scrollWidth - script.clientWidth).toBeLessThanOrEqual(1);
    expect(screen.getByText('hello')).toBeDefined();
  });

  it('T-FW7b: polls workload logs and shows a running record advancing to its terminal status', () => {
    setupData({
      containers: [container()],
      logs: [workloadLog({ id: 'l1', status: 'RUNNING', log: '', finishedAt: null })],
    });
    const { rerender } = render(<CloudContainersPage />);

    fireEvent.click(screen.getByRole('button', { name: '工作负载日志 zag-worker-abc123' }));
    expect(screen.getByText('执行中')).toBeDefined();
    // 执行记录查询带轮询间隔（PRD 功能点 5：执行中记录实时可刷新）
    expect(mocks.useQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pollInterval: 5000 }),
    );

    // 模拟下一次轮询返回终态：状态由「执行中」推进为「成功」，选中项不变
    setupData({
      containers: [container()],
      logs: [workloadLog({ id: 'l1', status: 'SUCCESS', log: 'done\n' })],
    });
    rerender(<CloudContainersPage />);

    expect(screen.getByText('成功')).toBeDefined();
    expect(screen.queryByText('执行中')).toBeNull();
    expect(screen.getByText('done')).toBeDefined();
  });

  it('T-FW7c: a refresh button refetches workload logs', () => {
    setupData({ containers: [container()], logs: [workloadLog()] });
    render(<CloudContainersPage />);

    fireEvent.click(screen.getByRole('button', { name: '工作负载日志 zag-worker-abc123' }));
    mocks.refetch.mockClear();

    fireEvent.click(screen.getByRole('button', { name: '刷新工作负载日志' }));
    expect(mocks.refetch).toHaveBeenCalled();
  });

  it('T-FW8: keeps the open logs dialog across a 10s polling refresh', () => {
    setupData({ containers: [container()], logs: [workloadLog()] });
    const { rerender } = render(<CloudContainersPage />);

    fireEvent.click(screen.getByRole('button', { name: '工作负载日志 zag-worker-abc123' }));
    expect(screen.getByText('工作负载执行日志')).toBeDefined();

    // 轮询刷新（loading=true 且已有 data）不得关闭用户正在操作的日志对话框
    mocks.useQuery.mockImplementation((doc: unknown) => {
      const source = String(doc);
      if (source.includes('AdminCloudContainerWorkloadLogs')) {
        return { data: { adminCloudContainerWorkloadLogs: [workloadLog()] }, loading: true };
      }
      if (source.includes('AdminCloudWorkloads')) return { data: undefined, loading: true };
      return {
        data: {
          adminCloudContainers: [container()],
          adminCloudContainerControlPlane: { online: true, message: null },
        },
        loading: true,
      };
    });
    rerender(<CloudContainersPage />);

    expect(screen.getByText('工作负载执行日志')).toBeDefined();
    expect(screen.getAllByText('zag-worker-abc123').length).toBeGreaterThanOrEqual(1);
  });
});
