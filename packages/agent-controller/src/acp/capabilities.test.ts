import { describe, it, expect } from 'vitest';
import {
  CLIENT_CAPABILITIES,
  FEATURE_IDS,
  normalizeCapabilities,
  type AgentCapabilitySnapshot,
} from './capabilities.js';
import opencodeFixture from './__fixtures__/opencode-2.0.31-capabilities.json' with { type: 'json' };

type Fixture = {
  protocolVersion: number;
  agentCapabilities: Record<string, unknown>;
  authMethods: unknown[];
  agentInfo: { name: string; version: string };
};

const fixture = opencodeFixture as Fixture;

const MODEL_CONFIG = [
  { id: 'model', type: 'select', category: 'model' },
  { id: 'mode', type: 'select', category: 'mode' },
];

function normalizeWith(overrides: {
  agentCapabilities?: unknown;
  authMethods?: unknown;
  clientCapabilities?: unknown;
  configOptions?: Array<{ id: string; type: string; category?: string | null }>;
  modes?: Array<{ id: string; name: string }>;
} = {}): AgentCapabilitySnapshot {
  return normalizeCapabilities({
    protocolVersion: fixture.protocolVersion,
    agentInfo: fixture.agentInfo,
    agentCapabilities: overrides.agentCapabilities === undefined
      ? fixture.agentCapabilities
      : overrides.agentCapabilities,
    authMethods: overrides.authMethods === undefined ? fixture.authMethods : overrides.authMethods,
    clientCapabilities: overrides.clientCapabilities === undefined
      ? CLIENT_CAPABILITIES
      : overrides.clientCapabilities,
    configOptions: overrides.configOptions ?? MODEL_CONFIG,
    modes: overrides.modes ?? [],
  });
}

function statusOf(snapshot: AgentCapabilitySnapshot, id: string) {
  return snapshot.features.find((f) => f.id === id);
}

describe('normalizeCapabilities', () => {
  it('T-C1: OpenCode 2.0.31 fixture 全量归一化', () => {
    const snapshot = normalizeWith();
    const fixtureFeatures = fixture.agentCapabilities as {
      promptCapabilities: { image: boolean };
      sessionCapabilities: Record<string, unknown>;
    };
    expect(fixtureFeatures.promptCapabilities.image).toBe(true);
    expect(fixtureFeatures.sessionCapabilities.fork).toEqual({});

    expect(snapshot.features.map((f) => f.id)).toEqual([...FEATURE_IDS]);

    for (const id of ['session.load', 'session.resume', 'session.close', 'session.list', 'session.delete']) {
      expect(statusOf(snapshot, id)?.status).toBe('supported');
    }
    expect(statusOf(snapshot, 'prompt.image')?.status).toBe('partial');
    expect(statusOf(snapshot, 'prompt.embeddedContext')?.status).toBe('partial');
    expect(statusOf(snapshot, 'prompt.audio')?.status).toBe('unsupported');
    expect(statusOf(snapshot, 'session.fork')?.status).toBe('partial');
    expect(statusOf(snapshot, 'session.additionalDirectories')?.status).toBe('partial');
    expect(statusOf(snapshot, 'config.model')?.status).toBe('supported');
    expect(statusOf(snapshot, 'config.mode')?.status).toBe('supported');
    expect(statusOf(snapshot, 'mcp.http')?.status).toBe('supported');
    expect(statusOf(snapshot, 'mcp.sse')?.status).toBe('unsupported');
    expect(statusOf(snapshot, 'commands')?.status).toBe('partial');
    expect(statusOf(snapshot, 'elicitation.form')?.status).toBe('supported');
    expect(statusOf(snapshot, 'elicitation.url')?.status).toBe('supported');
  });

  it('T-C2: agentCapabilities 为 null（旧 Agent）时仍返回全集，声明类全部 unsupported', () => {
    const snapshot = normalizeWith({ agentCapabilities: null, authMethods: [], configOptions: [], modes: [] });

    expect(snapshot.features).toHaveLength(FEATURE_IDS.length);
    for (const id of [
      'session.load',
      'session.resume',
      'session.close',
      'session.list',
      'session.delete',
      'session.fork',
      'session.additionalDirectories',
      'prompt.image',
      'prompt.audio',
      'prompt.embeddedContext',
      'auth.login',
      'auth.logout',
      'mcp.http',
      'mcp.sse',
      'config.model',
      'config.mode',
    ]) {
      const feature = statusOf(snapshot, id);
      expect(feature?.status, id).toBe('unsupported');
      expect(feature?.detail, id).toMatch(/^未声明 /);
    }
    // 本端声明的能力仍为 supported
    expect(statusOf(snapshot, 'elicitation.form')?.status).toBe('supported');
    expect(statusOf(snapshot, 'elicitation.url')?.status).toBe('supported');
    expect(statusOf(snapshot, 'config.boolean')?.status).toBe('supported');
  });

  it('T-C3: {} 与 false 区分', () => {
    const snapshot = normalizeWith({
      agentCapabilities: { sessionCapabilities: { resume: {}, close: false } },
    });

    expect(statusOf(snapshot, 'session.resume')?.status).toBe('supported');
    expect(statusOf(snapshot, 'session.close')?.status).toBe('unsupported');
    expect(statusOf(snapshot, 'session.close')?.detail).toContain('sessionCapabilities.close');
  });

  it('T-C4: authMethods 非空时 auth.login=partial，auth.logout=unsupported', () => {
    const snapshot = normalizeWith({
      authMethods: [{ id: 'login' }],
      agentCapabilities: {},
    });

    expect(statusOf(snapshot, 'auth.login')?.status).toBe('partial');
    expect(statusOf(snapshot, 'auth.login')?.detail).toContain('平台');
    expect(statusOf(snapshot, 'auth.logout')?.status).toBe('unsupported');
    expect(statusOf(snapshot, 'auth.logout')?.detail).toMatch(/^未声明 /);
  });

  it('T-C5: 无 mode 配置项但 modes[] 非空时 config.mode=supported', () => {
    const snapshot = normalizeWith({
      configOptions: [{ id: 'model', type: 'select', category: 'model' }],
      modes: [{ id: 'build', name: 'Build' }],
    });

    expect(statusOf(snapshot, 'config.mode')?.status).toBe('supported');
  });

  it('T-C6: _meta 扩展键原样进入 raw，不产生 feature', () => {
    const snapshot = normalizeWith();

    expect(snapshot.features).toHaveLength(FEATURE_IDS.length);
    expect(snapshot.features.some((f) => f.id.includes('_meta'))).toBe(false);
    expect((snapshot.raw.agentCapabilities as { _meta?: unknown })._meta).toEqual({
      'opencode/child-session-updates': true,
    });
  });

  it('T-C7: raw 保真（三份声明与入参深相等）', () => {
    const snapshot = normalizeWith();

    expect(snapshot.raw.agentCapabilities).toEqual(fixture.agentCapabilities);
    expect(snapshot.raw.authMethods).toEqual(fixture.authMethods);
    expect(snapshot.raw.clientCapabilities).toEqual(CLIENT_CAPABILITIES);
    expect(snapshot.protocolVersion).toBe(1);
    expect(snapshot.agentInfo).toEqual({ name: 'OpenCode', version: '2.0.31' });
  });

  it('T-C8: detail 文案（unsupported 以「未声明 <字段>」开头；partial 含「平台」）', () => {
    const snapshot = normalizeWith();

    for (const feature of snapshot.features) {
      if (feature.status === 'unsupported') {
        expect(feature.detail, feature.id).toMatch(/^未声明 /);
      }
      if (feature.status === 'partial') {
        expect(feature.detail, feature.id).toContain('平台');
      }
    }
  });
});
