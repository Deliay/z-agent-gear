import { describe, it, expect, vi } from 'vitest';
import { AcpAuthGate, AuthRequiredError } from './auth-gate.js';
import type { KimiLoginHandlers, KimiLoginTerminal } from '../harness/kimi-login.js';
import type { KimiLoginFlowLike } from './auth-gate.js';

interface FakeFlow {
  run: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  finish: (outcome: KimiLoginTerminal) => void;
  handlers: () => KimiLoginHandlers;
}

function createFakeFlow(): FakeFlow {
  let resolve!: (outcome: KimiLoginTerminal) => void;
  let handlers: KimiLoginHandlers = {};
  const run = vi.fn((value: KimiLoginHandlers = {}) => {
    handlers = value;
    return new Promise<KimiLoginTerminal>((done) => {
      resolve = done;
    });
  });
  return {
    run,
    cancel: vi.fn(),
    finish: (outcome) => resolve(outcome),
    handlers: () => handlers,
  };
}

function setup(options: { cacheTtlMs?: number; now?: () => number } = {}) {
  const flows: FakeFlow[] = [];
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  let seq = 0;
  const gate = new AcpAuthGate({
    emit: (event, payload) => emitted.push({ event, payload }),
    createFlow: () => {
      const flow = createFakeFlow();
      flows.push(flow);
      return flow as unknown as KimiLoginFlowLike;
    },
    createRequestId: () => `req-${++seq}`,
    ...(options.cacheTtlMs != null ? { cacheTtlMs: options.cacheTtlMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { gate, flows, emitted };
}

const DEVICE_FLOW = { url: 'https://kimi.test/login', userCode: 'CODE-1', expiresInSeconds: 1800 };

describe('AcpAuthGate', () => {
  it('T-AG1: 非 kimi_code 立即 resolve，不创建流程、不发事件', async () => {
    const { gate, flows, emitted } = setup();
    await expect(gate.ensure('opencode', 'acp:start')).resolves.toBeUndefined();
    expect(flows).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it('T-AG2/AG3: 缓存命中不重复登录，TTL 过期后重新登录', async () => {
    let now = 1_000;
    const { gate, flows } = setup({ cacheTtlMs: 100, now: () => now });
    const first = gate.ensure('kimi_code', 'probe-options');
    await Promise.resolve();
    flows[0].handlers().onDeviceFlow?.(DEVICE_FLOW);
    flows[0].finish({ state: 'logged-in', account: 'managed:kimi-code' });
    await first;

    await expect(gate.ensure('kimi_code', 'acp:start')).resolves.toBeUndefined();
    expect(flows).toHaveLength(1);

    now += 101;
    const second = gate.ensure('kimi_code', 'acp:start');
    await Promise.resolve();
    expect(flows).toHaveLength(2);
    flows[1].finish({ state: 'logged-in' });
    await second;
  });

  it('T-AG4: 并发 3 次 ensure → 只 1 次 spawn、1 次 required、3 个 resolve', async () => {
    const { gate, flows, emitted } = setup();
    const all = [
      gate.ensure('kimi_code', 'probe-options'),
      gate.ensure('kimi_code', 'acp:start'),
      gate.ensure('kimi_code', 'acp:resume'),
    ];
    await Promise.resolve();
    expect(flows).toHaveLength(1);
    flows[0].handlers().onDeviceFlow?.(DEVICE_FLOW);
    flows[0].finish({ state: 'logged-in' });
    await expect(Promise.all(all)).resolves.toEqual([undefined, undefined, undefined]);
    expect(emitted.filter((item) => item.event === 'harness:login:required')).toHaveLength(1);
    expect(emitted.map((item) => item.event)).toEqual([
      'harness:login:required',
      'harness:login:succeeded',
    ]);
    expect(emitted[0].payload).toEqual({
      requestId: 'req-1',
      serverType: 'kimi_code',
      trigger: 'probe-options',
      ...DEVICE_FLOW,
    });
  });

  it('T-AG5: 失败 → 三次均 reject AuthRequiredError 并上行 failed', async () => {
    const { gate, flows, emitted } = setup();
    const all = [
      gate.ensure('kimi_code', 'probe-options'),
      gate.ensure('kimi_code', 'acp:start'),
      gate.ensure('kimi_code', 'acp:resume'),
    ];
    await Promise.resolve();
    flows[0].finish({ state: 'failed', reason: 'cancelled' });
    for (const promise of all) {
      await expect(promise).rejects.toBeInstanceOf(AuthRequiredError);
      await expect(promise).rejects.toThrow('Kimi Code 未登录');
    }
    expect(emitted.at(-1)).toEqual({
      event: 'harness:login:failed',
      payload: { requestId: 'req-1', reason: 'cancelled' },
    });
  });

  it('T-AG6: cancel 定向（其他 requestId 无效，当前生效）', async () => {
    const { gate, flows } = setup();
    const pending = gate.ensure('kimi_code', 'acp:start');
    await Promise.resolve();
    gate.cancel('req-other');
    expect(flows[0].cancel).not.toHaveBeenCalled();
    gate.cancel('req-1');
    expect(flows[0].cancel).toHaveBeenCalledTimes(1);
    flows[0].finish({ state: 'failed', reason: 'cancelled' });
    await expect(pending).rejects.toBeInstanceOf(AuthRequiredError);
    expect(gate.pendingRequestId).toBeNull();
  });

  it('T-AG7: 无 device-flow 且成功 → 仍写缓存（不误判）', async () => {
    const { gate, flows, emitted } = setup();
    const pending = gate.ensure('kimi_code', 'probe-options');
    await Promise.resolve();
    flows[0].finish({ state: 'logged-in' });
    await expect(pending).resolves.toBeUndefined();
    expect(emitted.map((item) => item.event)).toEqual(['harness:login:succeeded']);
    await expect(gate.ensure('kimi_code', 'acp:start')).resolves.toBeUndefined();
    expect(flows).toHaveLength(1);
  });
});
