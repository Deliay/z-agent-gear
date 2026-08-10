import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockNewSession, mockInitialize } = vi.hoisted(() => {
  const mockNewSession = vi.fn().mockResolvedValue({ sessionId: 'acp-probe-1' });
  const mockInitialize = vi.fn().mockResolvedValue({ protocolVersion: 1 });
  return { mockNewSession, mockInitialize };
});

vi.mock('@agentclientprotocol/sdk', () => ({
  ndJsonStream: vi.fn(() => ({})),
  ClientSideConnection: vi.fn(function () {
    return {
      initialize: mockInitialize,
      newSession: mockNewSession,
      prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
      cancel: vi.fn().mockResolvedValue(undefined),
      closeSession: vi.fn().mockResolvedValue({}),
      setSessionMode: vi.fn().mockResolvedValue({}),
      setSessionConfigOption: vi.fn().mockResolvedValue({}),
    };
  }),
}));

const mockSpawnerStop = vi.fn();
vi.mock('./spawner.js', () => ({
  AcpSpawner: vi.fn(function () {
    return {
      start: vi.fn(),
      stop: mockSpawnerStop,
      isRunning: vi.fn().mockReturnValue(true),
      stdin: new WritableStream(),
      stdout: new ReadableStream(),
      closed: Promise.resolve(),
    };
  }),
}));

import { probeAcpServerOptions } from './prober.js';

describe('probeAcpServerOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('session/new 返回 modes + configOptions 时提取 Mode/模型选项并关闭进程', async () => {
    mockInitialize.mockResolvedValue({ protocolVersion: 1 });
    mockNewSession.mockResolvedValue({
      sessionId: 'acp-probe-1',
      modes: {
        availableModes: [
          { id: 'code', name: 'Code', description: '编码模式' },
          { id: 'ask', name: 'Ask' },
        ],
        currentModeId: 'code',
      },
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'gpt-5',
          options: [
            { value: 'gpt-5', name: 'GPT-5' },
            { value: 'claude-4', name: 'Claude 4' },
          ],
        },
      ],
    });

    const result = await probeAcpServerOptions('opencode');

    expect(result.modes).toEqual([
      { id: 'code', name: 'Code', description: '编码模式' },
      { id: 'ask', name: 'Ask', description: undefined },
    ]);
    expect(result.currentModeId).toBe('code');
    expect(result.availableModels).toEqual([
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'claude-4', name: 'Claude 4' },
    ]);
    expect(result.currentModelId).toBe('gpt-5');
    expect(mockSpawnerStop).toHaveBeenCalled();
  });

  it('Agent 无 modes/models 时返回空数组而非失败', async () => {
    mockNewSession.mockResolvedValue({ sessionId: 'acp-probe-2' });

    const result = await probeAcpServerOptions('opencode');

    expect(result.modes).toEqual([]);
    expect(result.availableModels).toEqual([]);
    expect(result.currentModeId).toBeNull();
    expect(result.currentModelId).toBeNull();
  });

  it('initialize 失败时 reject 并关闭进程', async () => {
    mockInitialize.mockRejectedValueOnce(new Error('handshake failed'));

    await expect(probeAcpServerOptions('opencode')).rejects.toThrow('handshake failed');
    expect(mockSpawnerStop).toHaveBeenCalled();
  });
});
