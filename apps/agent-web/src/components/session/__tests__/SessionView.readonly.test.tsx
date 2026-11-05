import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import SessionView from '../SessionView';
import { GET_CONTROLLERS, GET_SESSION } from '../../../graphql/queries';
import type { ControllerData, SessionData, SessionReadOnlyReason } from '../../../graphql/types';

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

const READ_ONLY_CASES: Array<{
  reason: SessionReadOnlyReason;
  notice: string;
  cloud?: boolean;
}> = [
  { reason: 'WORKSPACE_MISSING', notice: '工作区已不存在，会话记录仅供只读回看。' },
  { reason: 'CONTROLLER_MISSING', notice: '控制器已不存在，会话记录仅供只读回看。' },
  { reason: 'CLOUD_HOST_DESTROYED', notice: '云电脑已销毁，会话记录仅供只读回看。', cloud: true },
];

describe('SessionView 只读收敛 readOnlyReason（T-WEB3）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it.each(READ_ONLY_CASES)(
    'T-WEB3 $reason 展示分文案提示条并隐藏输入框与「继续」',
    ({ reason, notice, cloud }) => {
      mockQueries(
        makeSession({ readOnlyReason: reason }),
        cloud ? [] : [makeController()],
      );

      render(<SessionView sessionId="session-1" />);

      expect(screen.getByTestId('session-readonly-notice')).toHaveTextContent(notice);
      expect(screen.queryByTestId('input-box')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument();
      expect(screen.getByTestId('message-list')).toBeInTheDocument();
      if (cloud) {
        // 云电脑场景回归：旧 testid 保留且含文案（D10）
        expect(screen.getByTestId('cloud-host-readonly-notice')).toHaveTextContent(notice);
      } else {
        expect(screen.queryByTestId('cloud-host-readonly-notice')).not.toBeInTheDocument();
      }
    },
  );

  it('T-WEB3 运行环境完好的会话不展示只读提示条，输入框与「继续」可用', () => {
    mockQueries(makeSession({ readOnlyReason: null }), [makeController()]);

    render(<SessionView sessionId="session-1" />);

    expect(screen.queryByTestId('session-readonly-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cloud-host-readonly-notice')).not.toBeInTheDocument();
    expect(screen.getByTestId('input-box')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument();
  });
});
