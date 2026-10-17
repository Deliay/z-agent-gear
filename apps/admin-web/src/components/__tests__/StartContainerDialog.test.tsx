import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import StartContainerDialog from '@/components/cloud-containers/StartContainerDialog';
import type { CloudWorkloadData } from '@/graphql/types';

function workload(overrides: Partial<CloudWorkloadData> = {}): CloudWorkloadData {
  return {
    id: 'w',
    name: 'workload',
    initScript: 'echo init',
    postScript: null,
    paramSchema: [],
    dependsOnWorkloadIds: [],
    isPreset: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

const docker = workload({ id: 'd1', name: 'Docker' });
const dotnet = workload({ id: 'd2', name: '.NET' });
const aspire = workload({ id: 'd3', name: 'Aspire', dependsOnWorkloadIds: ['d1', 'd2'] });
const node = workload({
  id: 'd4',
  name: 'Node.js',
  paramSchema: [
    { key: 'version', label: '版本', type: 'TEXT', options: [], defaultValue: '22' },
    {
      key: 'package_manager',
      label: '包管理器',
      type: 'MULTI_SELECT',
      options: ['npm', 'pnpm', 'bun', 'yarn'],
      defaultValue: ['npm'],
    },
  ],
});
const app = workload({ id: 'd5', name: 'App', dependsOnWorkloadIds: ['d4'] });

const allWorkloads = [docker, dotnet, aspire, node, app];

function renderDialog(onStart = vi.fn().mockResolvedValue(undefined)) {
  render(
    <StartContainerDialog
      open
      onOpenChange={() => {}}
      workloads={allWorkloads}
      onStart={onStart}
    />,
  );
  return onStart;
}

describe('StartContainerDialog (T-FP5/T-FP6/T-FP7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-FP5: expands a param form with defaults for a workload that has params', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Node.js' }));

    expect((screen.getByLabelText('版本') as HTMLInputElement).value).toBe('22');
    expect(screen.getByRole('checkbox', { name: 'npm' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'pnpm' })).not.toBeChecked();
  });

  it('T-FP5: shows a "no params" hint for a workload without params', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Docker' }));
    expect(screen.getByText('无参数')).toBeDefined();
  });

  it('T-FP6: hints implicit dependencies and previews the init order', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Aspire' }));

    expect(screen.getByText('将自动初始化 Docker、.NET（默认参数）')).toBeDefined();

    const previewSection = screen.getByText('初始化顺序预览').closest('div');
    const order = within(previewSection as HTMLElement)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(order).toEqual(['Docker隐式', '.NET隐式', 'Aspire']);
  });

  it('T-FP7: submits explicit dependency params and passes defaults for the dependent', async () => {
    const onStart = renderDialog();
    // 先显式选择依赖方 App，再显式选择依赖 Node.js 并调整参数
    fireEvent.click(screen.getByRole('checkbox', { name: 'App' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Node.js' }));
    fireEvent.change(screen.getByLabelText('版本'), { target: { value: '20' } });

    fireEvent.click(screen.getByRole('button', { name: '确认启动' }));

    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith('IDLE', [
        { workloadId: 'd5', params: {} },
        { workloadId: 'd4', params: { version: '20', package_manager: ['npm'] } },
      ]),
    );
  });

  it('T-FP5: submits an empty selection when nothing is checked', async () => {
    const onStart = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '确认启动' }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith('IDLE', []));
  });

  it('T-FP6: blocks starting when expanded dependencies exceed the mount limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => workload({ id: `m${i}`, name: `dep-${i}` }));
    const boss = workload({
      id: 'boss',
      name: 'Boss',
      dependsOnWorkloadIds: many.map((item) => item.id),
    });
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(
      <StartContainerDialog
        open
        onOpenChange={() => {}}
        workloads={[...many, boss]}
        onStart={onStart}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Boss' }));

    expect(
      screen.getByText('展开依赖后超过单次挂载上限（10 个），无法启动。'),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: '确认启动' })).toBeDisabled();
  });

  it('T-FP7: submits a BOOLEAN false default through the whole start flow (key presence)', async () => {
    const flag = workload({
      id: 'd6',
      name: 'Flag',
      paramSchema: [{ key: 'enabled', label: '启用', type: 'BOOLEAN', options: [], defaultValue: false }],
    });
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(
      <StartContainerDialog open onOpenChange={() => {}} workloads={[flag]} onStart={onStart} />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Flag' }));
    expect(screen.getByRole('switch')).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: '确认启动' }));

    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith('IDLE', [
        { workloadId: 'd6', params: { enabled: false } },
      ]),
    );
  });

  it('T-FP7: keeps same-named params of different workloads independent', async () => {
    const first = workload({
      id: 'd7',
      name: 'First',
      paramSchema: [{ key: 'version', label: '版本', type: 'TEXT', options: [], defaultValue: '18' }],
    });
    const second = workload({
      id: 'd8',
      name: 'Second',
      paramSchema: [{ key: 'version', label: '版本', type: 'TEXT', options: [], defaultValue: '22' }],
    });
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(
      <StartContainerDialog
        open
        onOpenChange={() => {}}
        workloads={[first, second]}
        onStart={onStart}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'First' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Second' }));

    const versionInputs = screen.getAllByLabelText('版本') as HTMLInputElement[];
    fireEvent.change(versionInputs[0], { target: { value: '20' } });

    fireEvent.click(screen.getByRole('button', { name: '确认启动' }));

    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith('IDLE', [
        { workloadId: 'd7', params: { version: '20' } },
        { workloadId: 'd8', params: { version: '22' } },
      ]),
    );
  });

  it('T-FP7: normalizes MULTI_SELECT params to option order for a stable snapshot', async () => {
    const onStart = renderDialog();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Node.js' }));
    // 取消默认 npm；先勾 yarn 再勾 bun（可选项顺序为 npm,pnpm,bun,yarn）
    fireEvent.click(screen.getByRole('checkbox', { name: 'npm' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'yarn' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'bun' }));

    fireEvent.click(screen.getByRole('button', { name: '确认启动' }));

    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith('IDLE', [
        { workloadId: 'd4', params: { version: '22', package_manager: ['bun', 'yarn'] } },
      ]),
    );
  });

  it('T-FP6: blocks starting on a dependency cycle', () => {
    const a = workload({ id: 'c1', name: 'Cyc-A', dependsOnWorkloadIds: ['c2'] });
    const b = workload({ id: 'c2', name: 'Cyc-B', dependsOnWorkloadIds: ['c1'] });
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(
      <StartContainerDialog open onOpenChange={() => {}} workloads={[a, b]} onStart={onStart} />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Cyc-A' }));

    expect(screen.getByText(/检测到依赖环/)).toBeDefined();
    expect(screen.getByRole('button', { name: '确认启动' })).toBeDisabled();
  });

  it('T-FP6: blocks starting when a dependency no longer exists', () => {
    const orphan = workload({ id: 'o1', name: 'Orphan', dependsOnWorkloadIds: ['gone'] });
    const onStart = vi.fn().mockResolvedValue(undefined);
    render(
      <StartContainerDialog open onOpenChange={() => {}} workloads={[orphan]} onStart={onStart} />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Orphan' }));

    expect(screen.getByText(/依赖的工作负载不存在：gone/)).toBeDefined();
    expect(screen.getByRole('button', { name: '确认启动' })).toBeDisabled();
  });
});
