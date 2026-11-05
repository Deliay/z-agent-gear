import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SessionView from '../SessionView';
import { GET_CONTROLLERS, GET_SESSION } from '../../../graphql/queries';
import { toast } from 'sonner';
import type { ControllerData, SessionData } from '../../../graphql/types';

const mockUseQuery = vi.fn();
const mockArchiveSession = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: () => [mockArchiveSession],
  useApolloClient: () => ({ query: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
  },
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
    controllerId: 'ctrl-1',
    controllerName: '本机',
    controllerType: 'local',
    cloudHost: null,
    acpServerType: 'opencode',
    status: 'ended',
    title: '会话一',
    externalSessionId: null,
    cwd: '/home/user/project',
    worktreePath: null,
    worktreeBranch: null,
    archived: false,
    readOnlyReason: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T01:00:00Z',
    ...overrides,
  };
}

function makeController(overrides: Partial<ControllerData> = {}): ControllerData {
  return {
    id: 'ctrl-1',
    name: '本机',
    hostname: 'host-a',
    type: 'local',
    status: 'online',
    keyId: 'key-1',
    version: '1.0.0',
    lastHeartbeatAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    cloudHost: null,
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

describe('SessionView 会话归档（T-WEB1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockArchiveSession.mockResolvedValue({ data: { archiveSession: true } });
  });

  it('普通会话渲染「归档」入口（工作流节点会话除外）', () => {
    mockQueries(makeSession(), [makeController()]);

    render(<SessionView sessionId="session-1" />);

    expect(screen.getByRole('button', { name: '归档' })).toBeInTheDocument();
  });

  it('点击归档调用 archiveSession 并返回会话列表', async () => {
    const onDeleted = vi.fn();
    mockQueries(makeSession(), [makeController()]);

    render(<SessionView sessionId="session-1" onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole('button', { name: '归档' }));

    await waitFor(() =>
      expect(mockArchiveSession).toHaveBeenCalledWith(
        expect.objectContaining({ variables: { id: 'session-1', archived: true } }),
      ),
    );
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('会话已归档');
  });

  it('已归档会话点击「取消归档」就地生效（不返回列表）', async () => {
    const onDeleted = vi.fn();
    mockQueries(makeSession({ archived: true }), [makeController()]);

    render(<SessionView sessionId="session-1" onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole('button', { name: '取消归档' }));

    await waitFor(() =>
      expect(mockArchiveSession).toHaveBeenCalledWith(
        expect.objectContaining({ variables: { id: 'session-1', archived: false } }),
      ),
    );
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('已取消归档');
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('工作流节点会话不渲染归档入口', () => {
    mockQueries(
      makeSession({ workflowInstanceId: 'inst-1', workflowNodeId: 'node-1' }),
      [makeController()],
    );

    render(<SessionView sessionId="session-1" />);

    expect(screen.queryByRole('button', { name: '归档' })).toBeNull();
    expect(screen.queryByRole('button', { name: '取消归档' })).toBeNull();
  });
});
