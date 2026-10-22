import { describe, it, expect, vi } from 'vitest';
import { buildAcpInitResult, connectToServer } from './socketio-client.js';

const socketMock = vi.hoisted(() => {
  const handlers = new Map<string, (payload: unknown) => void>();
  const socket: Record<string, unknown> = {};
  socket.on = (event: string, handler: (payload: unknown) => void) => {
    handlers.set(event, handler);
    return socket;
  };
  socket.emit = vi.fn(() => socket);
  socket.disconnect = vi.fn(() => socket);
  socket.close = vi.fn(() => socket);
  return { socket, handlers };
});

vi.mock('socket.io-client', () => ({ io: () => socketMock.socket }));

describe('buildAcpInitResult', () => {
  it('T-SC1: payload 带 capabilities 时透传，既有字段一个不少', () => {
    const capabilities = {
      protocolVersion: 1,
      agentInfo: { name: 'OpenCode', version: '2.0.31' },
      features: [{ id: 'session.load', status: 'supported', detail: null }],
      raw: { agentCapabilities: {}, authMethods: [], clientCapabilities: {} },
    };
    const payload = {
      sessionId: 'sess-1',
      acpSessionId: 'acp-1',
      modes: [{ id: 'build', name: 'Build' }],
      currentModeId: 'build',
      currentModel: { id: 'm1', name: 'M1' },
      availableModels: [{ id: 'm1', name: 'M1' }],
      currentModelId: 'm1',
      configOptions: [{ id: 'model', type: 'select' }],
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      agentInfo: { name: 'OpenCode', version: '2.0.31' },
      authMethods: [{ id: 'login', kind: 'agent' }],
      supportsAdditionalDirectories: true,
      capabilities,
    };

    const result = buildAcpInitResult(payload);

    expect(result.capabilities).toEqual(capabilities);
    expect(result.modes).toEqual(payload.modes);
    expect(result.currentModeId).toBe('build');
    expect(result.currentModel).toEqual(payload.currentModel);
    expect(result.availableModels).toEqual(payload.availableModels);
    expect(result.currentModelId).toBe('m1');
    expect(result.configOptions).toEqual(payload.configOptions);
    expect(result.promptCapabilities).toEqual(payload.promptCapabilities);
    expect(result.agentInfo).toEqual(payload.agentInfo);
    expect(result.authMethods).toEqual(payload.authMethods);
    expect(result.supportsAdditionalDirectories).toBe(true);
    // requestId/sessionId/success 由调用处补充，纯函数不负责
    expect(result).not.toHaveProperty('requestId');
  });

  it('T-SC2: 旧 payload 不带 capabilities 时结果不含该键（零退化）', () => {
    const result = buildAcpInitResult({
      modes: [],
      availableModels: [],
      configOptions: [],
    });

    expect(result).not.toHaveProperty('capabilities');
    expect(result.modes).toEqual([]);
    expect(result.availableModels).toEqual([]);
    expect(result.configOptions).toEqual([]);
    expect(result).not.toHaveProperty('currentModeId');
    expect(result).not.toHaveProperty('agentInfo');
  });
});


describe('workload:run onBeforeWorkloadBatch (T-SC-G)', () => {
  it('T-SC-G1: forwards the hook to the executor and reports failed results when it throws', async () => {
    const hook = vi.fn(async () => {
      throw new Error('未设置 Github 项目');
    });
    const batchComplete = vi.fn();
    connectToServer('http://localhost:4010', 'key', {
      skipLocalMcpStart: true,
      handleWorkload: true,
      persistConfig: false,
      onBeforeWorkloadBatch: hook,
      onWorkloadBatchComplete: batchComplete,
    });

    const run = socketMock.handlers.get('workload:run')!;
    run({
      phase: 'init',
      githubAuth: true,
      items: [
        { logId: 'g1', workloadName: 'Git 项目设置', script: 'echo should-not-run', timeoutMs: 1000 },
        { logId: 'g2', workloadName: 'Git 项目设置', script: 'echo should-not-run', timeoutMs: 1000 },
      ],
    });

    await vi.waitFor(() => expect(batchComplete).toHaveBeenCalledTimes(1));

    expect(hook).toHaveBeenCalledTimes(1);
    const resultCalls = (socketMock.socket.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 'workload:result',
    );
    expect(resultCalls.map((call) => call[1].logId)).toEqual(['g1', 'g2']);
    expect(resultCalls.map((call) => call[1].status)).toEqual(['failed', 'failed']);
    expect(resultCalls[0][1].log).toBe('Github 凭据申请失败：未设置 Github 项目');
    expect(batchComplete.mock.calls[0][0]).toMatchObject({ status: 'failed', failedCount: 2 });
  });

  it('T-SC-G2: does not invoke the hook for batches without githubAuth', async () => {
    const hook = vi.fn(async () => {});
    const batchComplete = vi.fn();
    connectToServer('http://localhost:4011', 'key', {
      skipLocalMcpStart: true,
      handleWorkload: true,
      persistConfig: false,
      onBeforeWorkloadBatch: hook,
      onWorkloadBatchComplete: batchComplete,
    });

    const run = socketMock.handlers.get('workload:run')!;
    run({
      phase: 'post',
      items: [{ logId: 'legacy', workloadName: 'Legacy', script: 'echo legacy', timeoutMs: 5000 }],
    });

    await vi.waitFor(() => expect(batchComplete).toHaveBeenCalledTimes(1));
    expect(hook).not.toHaveBeenCalled();
    expect(batchComplete.mock.calls[0][0]).toMatchObject({ status: 'completed', failedCount: 0 });
  });
});
