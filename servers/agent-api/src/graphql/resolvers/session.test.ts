import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/session.js', () => ({
  sessionService: {
    findAllByUser: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock('../../services/session-import.js', () => ({
  sessionImportService: {},
}));

vi.mock('../../services/model.js', () => ({
  modelService: {
    listSourceLibrary: vi.fn(),
  },
}));

vi.mock('../../models/controller.js', () => ({
  Controller: { findOne: vi.fn() },
}));

import { sessionResolvers } from './session.js';
import { modelService } from '../../services/model.js';
import type { AuthContext } from './auth.js';

function createContext(): AuthContext {
  return { currentUser: { id: 'user-1', username: 'u' } };
}

describe('Session field resolvers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-SR1: features 返回快照内 features 的深拷贝', () => {
    const features = [{ id: 'session.load', status: 'supported', detail: null }];
    const session = { agentCapabilities: { features } };

    const result = sessionResolvers.Session.features(session);

    expect(result).toEqual(features);
    expect(result).not.toBe(features);
    result[0].id = 'mutated';
    expect(features[0].id).toBe('session.load');
  });

  it('T-SR2: 无快照/脏数据返回 []', () => {
    expect(sessionResolvers.Session.features({})).toEqual([]);
    expect(sessionResolvers.Session.features({ agentCapabilities: null })).toEqual([]);
    expect(sessionResolvers.Session.features({ agentCapabilities: { features: 'oops' } })).toEqual([]);
    expect(sessionResolvers.Session.agentCapabilities({})).toBeNull();
  });

  it('T-SR3: availableModels 按平台库/前缀/兜底分组', async () => {
    vi.mocked(modelService.listSourceLibrary).mockResolvedValue([
      { name: 'gpt-4o', scope: 'global' },
      { name: 'my-model', scope: 'user' },
    ]);

    const result = await sessionResolvers.Session.availableModels(
      {
        availableModels: [
          { id: 'gpt-4o', name: 'gpt-4o' },
          { id: 'my-model', name: 'my-model' },
          { id: 'opencode-go/kimi-k3', name: 'Kimi K3' },
          { id: 'local-llm', name: 'Local LLM' },
        ],
      },
      {},
      createContext(),
    );

    expect(result.map((m: { group: string }) => m.group)).toEqual([
      '平台内置',
      '自定义',
      'Agent 自带',
      '来源未知',
    ]);
    expect(result.map((m: { basis: string }) => m.basis)).toEqual([
      '按平台模型库比对（平台内置）',
      '按平台模型库比对（自定义）',
      '按标识前缀判定（opencode-go）',
      '无法判定',
    ]);
  });

  it('T-SR4: 同一 context 两次解析只调用一次 listSourceLibrary', async () => {
    vi.mocked(modelService.listSourceLibrary).mockResolvedValue([]);
    const context = createContext();
    const session = { availableModels: [{ id: 'a/b', name: 'B' }] };

    await sessionResolvers.Session.availableModels(session, {}, context);
    await sessionResolvers.Session.availableModels(session, {}, context);

    expect(modelService.listSourceLibrary).toHaveBeenCalledTimes(1);
  });

  it('T-SR5: 空 availableModels 不查库，返回 []', async () => {
    const result = await sessionResolvers.Session.availableModels(
      { availableModels: [] },
      {},
      createContext(),
    );

    expect(result).toEqual([]);
    expect(modelService.listSourceLibrary).not.toHaveBeenCalled();
  });
});
