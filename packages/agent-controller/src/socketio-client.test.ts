import { describe, it, expect } from 'vitest';
import { buildAcpInitResult } from './socketio-client.js';

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
