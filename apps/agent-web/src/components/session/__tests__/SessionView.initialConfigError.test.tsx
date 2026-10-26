import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import SessionView from '../SessionView';
import { GET_CONTROLLERS, GET_SESSION } from '../../../graphql/queries';
import type { ControllerData, SessionData } from '../../../graphql/types';
import { toast } from 'sonner';

const mockUseQuery = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
  },
}));

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

const eventSources: MockEventSource[] = [];

class MockEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  url: string;
  constructor(url: string) {
    this.url = url;
    eventSources.push(this);
  }
}

vi.stubGlobal('EventSource', MockEventSource);

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: 'session-1',
    userId: 'user-1',
    controllerId: 'ctrl-1',
    controllerName: '主机 A',
    controllerType: 'local',
    cloudHost: null,
    acpServerType: 'opencode',
    status: 'idling',
    title: '会话一',
    externalSessionId: null,
    cwd: '/root/workspace',
    worktreePath: null,
    worktreeBranch: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    endedAt: null,
    ...overrides,
  };
}

function makeController(overrides: Partial<ControllerData> = {}): ControllerData {
  return {
    id: 'ctrl-1',
    name: '主机 A',
    hostname: 'host-a',
    type: 'local',
    status: 'online',
    keyId: 'key-1',
    version: '1.0.0',
    lastHeartbeatAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
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

function emitSSE(payload: Record<string, unknown>) {
  const es = eventSources.at(-1);
  if (!es?.onmessage) throw new Error('EventSource not ready');
  act(() => {
    es.onmessage!({ data: JSON.stringify(payload) } as MessageEvent);
  });
}

describe('SessionView initialConfigError 提示', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    eventSources.length = 0;
  });

  it('收到 initialConfigError 时 toast 提示失败原因并展示当前生效的模式/模型', () => {
    mockQueries(makeSession(), [makeController()]);
    render(<SessionView sessionId="session-1" />);

    emitSSE({
      type: 'status',
      data: {
        sessionId: 'session-1',
        status: 'idling',
        currentModeId: 'code',
        currentModelId: 'gpt-4',
        modes: [{ id: 'code', name: 'Code' }],
        availableModels: [{ id: 'gpt-4', name: 'GPT-4' }],
        initialConfigError: { modeId: 'plan', modelId: 'gpt-5', error: 'model not supported', at: '2026-10-26T00:00:00Z' },
      },
    });

    expect(toast.error).toHaveBeenCalledTimes(1);
    const [message, options] = vi.mocked(toast.error).mock.calls[0];
    expect(message).toContain('模式/模型设置未生效');
    expect(message).toContain('model not supported');
    expect(options?.description).toContain('Code');
    expect(options?.description).toContain('GPT-4');
  });

  it('相同的 initialConfigError 重复下发时不重复提示', () => {
    mockQueries(makeSession(), [makeController()]);
    render(<SessionView sessionId="session-1" />);

    const payload = {
      type: 'status',
      data: {
        sessionId: 'session-1',
        status: 'idling',
        initialConfigError: { modeId: 'plan', error: 'mode not supported', at: '2026-10-26T00:00:00Z' },
      },
    };
    emitSSE(payload);
    emitSSE(payload);

    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('status 事件不含 initialConfigError 时不提示', () => {
    mockQueries(makeSession(), [makeController()]);
    render(<SessionView sessionId="session-1" />);

    emitSSE({ type: 'status', data: { sessionId: 'session-1', status: 'idling' } });

    expect(toast.error).not.toHaveBeenCalled();
  });
});
