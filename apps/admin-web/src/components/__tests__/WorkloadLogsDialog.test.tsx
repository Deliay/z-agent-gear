import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import WorkloadLogsDialog from '@/components/cloud-containers/WorkloadLogsDialog';
import { formatParams } from '@/lib/workload-params';

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock('@apollo/client', () => ({
  gql: (strings: TemplateStringsArray) => strings.join(''),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
}));

function log(overrides: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    containerId: 'c1',
    workloadId: 'w1',
    workloadName: 'setup-node',
    phase: 'INIT',
    status: 'SUCCESS',
    script: 'echo "hello"',
    params: {},
    exitCode: 0,
    log: 'hello\n',
    startedAt: '2026-10-14T10:00:35Z',
    finishedAt: '2026-10-14T10:00:40Z',
    ...overrides,
  };
}

function setup(logs: unknown[]) {
  mocks.useQuery.mockReturnValue({
    data: { adminCloudContainerWorkloadLogs: logs },
    loading: false,
    error: undefined,
    refetch: mocks.refetch,
  });
}

describe('WorkloadLogsDialog (T-FP9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the params snapshot alongside script and output', () => {
    setup([
      log({
        params: { version: '22', package_manager: ['npm'], enabled: false },
      }),
    ]);
    render(
      <WorkloadLogsDialog open onOpenChange={() => {}} containerId="c1" containerName="zag-worker" />,
    );

    expect(screen.getByText('参数快照')).toBeDefined();
    expect(screen.getByText(/version: 22/)).toBeDefined();
    expect(screen.getByText(/package_manager: \["npm"\]/)).toBeDefined();
    expect(screen.getByText(/enabled: false/)).toBeDefined();
  });

  it('shows "-" for historical records without params', () => {
    setup([log({ params: undefined })]);
    render(
      <WorkloadLogsDialog open onOpenChange={() => {}} containerId="c1" containerName="zag-worker" />,
    );

    expect(screen.getByText('参数快照')).toBeDefined();
    expect(screen.getByText('-')).toBeDefined();
  });

  it('formatParams renders "-" for an empty snapshot', () => {
    expect(formatParams({})).toBe('-');
    expect(formatParams(null)).toBe('-');
    expect(formatParams({ a: 'x' })).toBe('a: x');
  });
});
