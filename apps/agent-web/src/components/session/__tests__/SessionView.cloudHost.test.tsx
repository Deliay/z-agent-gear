import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import SessionView from '../SessionView';
import { GET_CONTROLLERS, GET_SESSION } from '../../../graphql/queries';
import type { CloudHostData, ControllerData, SessionData } from '../../../graphql/types';

const mockUseQuery = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => [vi.fn().mockResolvedValue({ data: {} })],
  useApolloClient: () => ({ query: vi.fn() }),
}));

vi.mock('../MessageList', () => ({
  default: () => <div data-testid="message-list">历史消息</div>,
}));

vi.mock('../InputBox', () => ({
  default: () => <textarea data-testid="input-box" />,
}));

vi.mock('../ResumeConfirmDialog', () => ({
  default: () => null,
}));

class MockEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  url: string;
  constructor(url: string) {
    this.url = url;
  }
}

vi.stubGlobal('EventSource', MockEventSource);

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: 'session-1',
    userId: 'user-1',
    controllerId: 'ctrl-cloud',
    controllerName: '云电脑 A',
    acpServerType: 'opencode',
    status: 'ended',
    title: '会话一',
    externalSessionId: null,
    cwd: '/root/workspace',
    worktreePath: null,
    worktreeBranch: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T01:00:00Z',
    ...overrides,
  };
}

function makeCloudHost(overrides: Partial<CloudHostData> = {}): CloudHostData {
  return {
    id: 'cloud-1',
    name: '云电脑 A',
    controllerId: 'ctrl-cloud',
    status: 'STOPPED',
    harnessTypes: ['OPENCODE'],
    defaultSessionId: null,
    activeSessionCount: 0,
    failureReason: null,
    deletedAt: null,
    ...overrides,
  };
}

function makeController(overrides: Partial<ControllerData> = {}): ControllerData {
  return {
    id: 'ctrl-cloud',
    name: '云电脑 A',
    hostname: 'cloud-host',
    type: 'cloud',
    status: 'offline',
    keyId: 'key-1',
    version: '1.0.0',
    lastHeartbeatAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    cloudHost: makeCloudHost(),
    ...overrides,
  };
}

function mockQueries(session: SessionData, controllers: ControllerData[]) {
  mockUseQuery.mockImplementation((query: unknown) => {
    if (query === GET_SESSION) {
      return { data: { session }, loading: false };
    }
    if (query === GET_CONTROLLERS) {
      return { data: { controllers }, loading: false };
    }
    return { data: null, loading: false };
  });
}

describe('SessionView 云电脑只读回看', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it.each([
    { status: 'STOPPED' as const, failureReason: null },
    { status: 'FAILED' as const, failureReason: 'container exited' },
  ])('T-AW10 云电脑终态($status)时隐藏输入/发送/继续，保留历史消息', ({ status, failureReason }) => {
    mockQueries(makeSession(), [
      makeController({
        cloudHost: makeCloudHost({ status, failureReason }),
      }),
    ]);

    render(<SessionView sessionId="session-1" />);

    expect(screen.getByTestId('message-list')).toBeInTheDocument();
    expect(screen.queryByTestId('input-box')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument();
    expect(screen.getByTestId('cloud-host-readonly-notice')).toBeInTheDocument();
  });

  it('T-AW10 软删除云电脑（cloudHost=null）仍按只读渲染', () => {
    mockQueries(makeSession(), [makeController({ cloudHost: null })]);

    render(<SessionView sessionId="session-1" />);

    expect(screen.getByTestId('message-list')).toBeInTheDocument();
    expect(screen.queryByTestId('input-box')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument();
    expect(screen.getByTestId('cloud-host-readonly-notice')).toBeInTheDocument();
  });

  it('T-AW11 普通已结束会话仍显示恢复入口与输入框', () => {
    mockQueries(makeSession({ controllerId: 'ctrl-local', controllerName: '本机' }), [
      makeController({
        id: 'ctrl-local',
        name: '本机',
        type: 'local',
        status: 'online',
        cloudHost: null,
      }),
    ]);

    render(<SessionView sessionId="session-1" />);

    expect(screen.getByTestId('message-list')).toBeInTheDocument();
    expect(screen.getByTestId('input-box')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument();
    expect(screen.queryByTestId('cloud-host-readonly-notice')).not.toBeInTheDocument();
  });

  it('T-AW11 云电脑 RUNNING 时已结束会话仍可恢复', () => {
    mockQueries(makeSession(), [makeController({ cloudHost: makeCloudHost({ status: 'RUNNING' }) })]);

    render(<SessionView sessionId="session-1" />);

    expect(screen.getByTestId('input-box')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument();
  });
});
