import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@agentclientprotocol/sdk', () => ({
  ndJsonStream: vi.fn(() => ({})),
  ClientSideConnection: vi.fn(function () {
    return {
      initialize: vi.fn().mockResolvedValue({ protocolVersion: 1 }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'acp-sess-abc' }),
      resumeSession: vi.fn().mockResolvedValue({}),
      prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
      cancel: vi.fn().mockResolvedValue(undefined),
      closeSession: vi.fn().mockResolvedValue({}),
      setSessionMode: vi.fn().mockResolvedValue({}),
      setSessionConfigOption: vi.fn().mockResolvedValue({}),
    };
  }),
}));

import { AcpSessionBridge } from './bridge.js';

class MockAcpSpawner {
  start = vi.fn();
  stop = vi.fn();
  isRunning = vi.fn().mockReturnValue(true);
  _stdin = new WritableStream();
  _stdout = new ReadableStream();
  get stdin() { return this._stdin; }
  get stdout() { return this._stdout; }
  get closed() { return Promise.resolve(); }
}

function createMockSocket() {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
}

describe('AcpSessionBridge - requestPermission', () => {
  let mockSocket: ReturnType<typeof createMockSocket>;
  let mockSpawner: MockAcpSpawner;

  function createBridge() {
    return new AcpSessionBridge(
      mockSocket as never,
      { sessionId: 'sess-1', cwd: '/home/user' },
      mockSpawner as never,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockSocket = createMockSocket();
    mockSpawner = new MockAcpSpawner();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should emit acp:permission and wait for response', async () => {
    const bridge = createBridge();
    const options = [
      { optionId: 'opt-1', name: 'Allow', kind: 'allow_once' as const },
      { optionId: 'opt-2', name: 'Reject', kind: 'reject_once' as const },
    ];

    const promise = bridge.requestPermission({
      toolCall: { toolCallId: 'tc-1' },
      options,
    } as never);

    expect(mockSocket.emit).toHaveBeenCalledWith('acp:permission', expect.objectContaining({
      sessionId: 'sess-1',
      toolCall: { toolCallId: 'tc-1' },
      options,
    }));

    const emitCall = mockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'acp:permission');
    const requestId = (emitCall![1] as { requestId: string }).requestId;
    expect(requestId).toMatch(/^perm_\d+_/);

    bridge.handlePermissionResponse(requestId, { outcome: 'selected', optionId: 'opt-1' });

    const result = await promise;
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-1' } });
  });

  it('should resolve with cancelled after 65s timeout', async () => {
    const bridge = createBridge();

    const promise = bridge.requestPermission({
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'opt-1', name: 'Allow', kind: 'allow_once' }],
    } as never);

    await vi.advanceTimersByTimeAsync(65_000);

    const result = await promise;
    expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('should not resolve with cancelled if response arrives before timeout', async () => {
    const bridge = createBridge();

    const promise = bridge.requestPermission({
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'opt-1', name: 'Allow', kind: 'allow_once' }],
    } as never);

    const emitCall = mockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'acp:permission');
    const requestId = (emitCall![1] as { requestId: string }).requestId;

    await vi.advanceTimersByTimeAsync(30_000);
    bridge.handlePermissionResponse(requestId, { outcome: 'selected', optionId: 'opt-1' });

    const result = await promise;
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-1' } });

    await vi.advanceTimersByTimeAsync(35_000);
  });

  it('should warn and ignore invalid requestId in handlePermissionResponse', () => {
    const bridge = createBridge();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    bridge.handlePermissionResponse('invalid-id', { outcome: 'selected', optionId: 'opt-1' });

    expect(warnSpy).toHaveBeenCalledWith('Permission request invalid-id not found');
    warnSpy.mockRestore();
  });

  it('should handle cancelled outcome from user', async () => {
    const bridge = createBridge();

    const promise = bridge.requestPermission({
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'opt-1', name: 'Allow', kind: 'allow_once' }],
    } as never);

    const emitCall = mockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'acp:permission');
    const requestId = (emitCall![1] as { requestId: string }).requestId;

    bridge.handlePermissionResponse(requestId, { outcome: 'cancelled' });

    const result = await promise;
    expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('should handle concurrent permission requests independently', async () => {
    const bridge = createBridge();

    const promise1 = bridge.requestPermission({
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'opt-1', name: 'Allow', kind: 'allow_once' }],
    } as never);

    const promise2 = bridge.requestPermission({
      toolCall: { toolCallId: 'tc-2' },
      options: [{ optionId: 'opt-2', name: 'Reject', kind: 'reject_once' }],
    } as never);

    const calls = mockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'acp:permission');
    expect(calls).toHaveLength(2);

    const requestId1 = (calls[0][1] as { requestId: string }).requestId;
    const requestId2 = (calls[1][1] as { requestId: string }).requestId;
    expect(requestId1).not.toBe(requestId2);

    bridge.handlePermissionResponse(requestId2, { outcome: 'selected', optionId: 'opt-2' });
    bridge.handlePermissionResponse(requestId1, { outcome: 'selected', optionId: 'opt-1' });

    const [result1, result2] = await Promise.all([promise1, promise2]);
    expect(result1).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-1' } });
    expect(result2).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-2' } });
  });

  it('should clean up pending entry after timeout', async () => {
    const bridge = createBridge();

    const promise = bridge.requestPermission({
      toolCall: { toolCallId: 'tc-1' },
      options: [{ optionId: 'opt-1', name: 'Allow', kind: 'allow_once' }],
    } as never);

    await vi.advanceTimersByTimeAsync(65_000);
    await promise;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emitCall = mockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'acp:permission');
    const requestId = (emitCall![1] as { requestId: string }).requestId;

    bridge.handlePermissionResponse(requestId, { outcome: 'selected', optionId: 'opt-1' });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
