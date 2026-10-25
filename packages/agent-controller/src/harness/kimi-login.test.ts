import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  KimiLoginFlow,
  classifyExit,
  parseKimiLoginLine,
  resolveKimiLoginWaitMs,
  sanitizeErrorSummary,
} from './kimi-login.js';

/** 实机核对逐字输出（附录 B5；URL/验证码为示例值）。 */
const DEVICE_FLOW_LINES = [
  'Opening browser for Kimi device login: https://www.kimi.com/code/authorize_device?user_code=4CQ4-0XIG',
  'If the browser did not open, paste the URL above and enter code: 4CQ4-0XIG',
  'Code expires in 1800s.',
  'Waiting for authorization to complete…',
];

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  killed: NodeJS.Signals | null;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = null;
  child.kill = vi.fn((signal: NodeJS.Signals) => {
    child.killed = signal;
    return true;
  });
  return child;
}

function setup(options: { waitMs?: number } = {}) {
  const child = createFakeChild();
  const spawnFn = vi.fn(() => child);
  const flow = new KimiLoginFlow({
    spawnFn: spawnFn as never,
    ...(options.waitMs ? { waitMs: options.waitMs } : {}),
  });
  return { child, spawnFn, flow };
}

/** 等待流式回调跑完（setImmediate 让出微任务队列）。 */
const tick = () => new Promise((resolve) => setImmediate(resolve));

function emitLines(child: FakeChild, lines: string[], stream: 'stdout' | 'stderr' = 'stderr', eol = '\n'): void {
  child[stream].emit('data', Buffer.from(`${lines.join(eol)}${eol}`));
}

describe('parseKimiLoginLine', () => {
  it('T-KL1: 已登录行解析 providerName（仅日志/事件透出，前端不展示）', () => {
    expect(parseKimiLoginLine('Logged in to managed:kimi-code.')).toEqual({
      kind: 'logged-in',
      account: 'managed:kimi-code',
    });
  });

  it('T-KL2: 设备码行逐字命中 url / 验证码 / 有效期 / 等待', () => {
    expect(parseKimiLoginLine(DEVICE_FLOW_LINES[0])).toEqual({
      kind: 'device-url',
      url: 'https://www.kimi.com/code/authorize_device?user_code=4CQ4-0XIG',
    });
    expect(parseKimiLoginLine(DEVICE_FLOW_LINES[1])).toEqual({ kind: 'user-code', userCode: '4CQ4-0XIG' });
    expect(parseKimiLoginLine('Code expires in 1800s.')).toEqual({
      kind: 'expires-in',
      expiresInSeconds: 1800,
    });
    expect(parseKimiLoginLine('Waiting for authorization to complete…')).toEqual({ kind: 'waiting' });
    expect(parseKimiLoginLine('   ')).toBeNull();
  });
});

describe('classifyExit', () => {
  it('exit 0 → logged-in；cancel 标志优先于 exit 0', () => {
    expect(classifyExit({ code: 0, account: 'managed:kimi-code' })).toEqual({
      state: 'logged-in',
      account: 'managed:kimi-code',
    });
    expect(classifyExit({ code: 0, cancelled: true })).toEqual({ state: 'failed', reason: 'cancelled' });
  });

  it('Login cancelled 文案 / 过期 / 其它 → cancelled / timeout / error', () => {
    expect(classifyExit({ code: 1, cancelMessage: true })).toEqual({ state: 'failed', reason: 'cancelled' });
    expect(classifyExit({ code: 1, expiresAt: 1000, now: 1000 })).toEqual({
      state: 'failed',
      reason: 'timeout',
    });
    const failed = classifyExit({ code: 1, errorMessage: 'boom' });
    expect(failed).toEqual({ state: 'failed', reason: 'error', error: 'boom' });
  });

  it('脱敏摘要 ≤200 且去控制字符', () => {
    const long = `\u001b[31m${'x'.repeat(300)}\n`;
    expect(sanitizeErrorSummary(long)).toHaveLength(200);
    expect(classifyExit({ code: null, signal: 'SIGKILL' })).toEqual({
      state: 'failed',
      reason: 'error',
      error: 'kimi login exited with SIGKILL',
    });
  });

  it('KIMI_LOGIN_WAIT_MS 可 env 覆盖', () => {
    expect(resolveKimiLoginWaitMs({})).toBe(1_800_000);
    expect(resolveKimiLoginWaitMs({ KIMI_LOGIN_WAIT_MS: '60000' })).toBe(60_000);
    expect(resolveKimiLoginWaitMs({ KIMI_LOGIN_WAIT_MS: '-1' })).toBe(1_800_000);
  });
});

describe('KimiLoginFlow', () => {
  it('T-KL1: 已登录快速路径 exit 0 → logged-in 且不触发 onDeviceFlow', async () => {
    const { child, flow, spawnFn } = setup();
    const onDeviceFlow = vi.fn();
    const pending = flow.run({ onDeviceFlow });
    expect(spawnFn).toHaveBeenCalledWith('kimi', ['login'], expect.objectContaining({
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    emitLines(child, ['Logged in to managed:kimi-code.']);
    child.emit('exit', 0, null);
    await expect(pending).resolves.toEqual({ state: 'logged-in', account: 'managed:kimi-code' });
    expect(onDeviceFlow).not.toHaveBeenCalled();
  });

  it('T-KL2: 设备码首次命中只上抛一次（重复 waiting 不重复）', async () => {
    const { child, flow } = setup();
    const onDeviceFlow = vi.fn();
    const pending = flow.run({ onDeviceFlow });
    emitLines(child, DEVICE_FLOW_LINES);
    emitLines(child, [DEVICE_FLOW_LINES[3]]);
    expect(onDeviceFlow).toHaveBeenCalledTimes(1);
    expect(onDeviceFlow).toHaveBeenCalledWith({
      url: 'https://www.kimi.com/code/authorize_device?user_code=4CQ4-0XIG',
      userCode: '4CQ4-0XIG',
      expiresInSeconds: 1800,
    });
    child.emit('exit', 0, null);
    await expect(pending).resolves.toEqual({ state: 'logged-in' });
  });

  it('T-KL3: stdout/stderr 交错 + \\r\\n 仍能解析', async () => {
    const { child, flow } = setup();
    const onDeviceFlow = vi.fn();
    const pending = flow.run({ onDeviceFlow });
    emitLines(child, [DEVICE_FLOW_LINES[0]], 'stdout', '\r\n');
    emitLines(child, [DEVICE_FLOW_LINES[1], DEVICE_FLOW_LINES[2]], 'stderr', '\r\n');
    await tick();
    expect(onDeviceFlow).toHaveBeenCalledWith(expect.objectContaining({ userCode: '4CQ4-0XIG' }));
    emitLines(child, [DEVICE_FLOW_LINES[3]], 'stdout', '\r\n');
    child.emit('exit', 0, null);
    await expect(pending).resolves.toEqual({ state: 'logged-in' });
  });

  it('T-KL4: 无特征输出 + exit 1 → failed(error)，摘要 ≤200 且脱敏', async () => {
    const { child, flow } = setup();
    const pending = flow.run();
    emitLines(child, [`Login failed: ${'bad '.repeat(80)}`]);
    child.emit('exit', 1, null);
    const outcome = await pending;
    expect(outcome.state).toBe('failed');
    if (outcome.state !== 'failed') return;
    expect(outcome.reason).toBe('error');
    expect(outcome.error!.length).toBeLessThanOrEqual(200);
    expect(outcome.error).not.toContain('\n');
  });

  it('T-KL5: cancel() → SIGTERM + failed(cancelled)，不误判 error', async () => {
    const { child, flow } = setup();
    const pending = flow.run();
    emitLines(child, DEVICE_FLOW_LINES.slice(0, 2));
    flow.cancel();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', null, 'SIGTERM');
    await expect(pending).resolves.toEqual({ state: 'failed', reason: 'cancelled' });
  });

  it('T-KL6: 等待上限到期 → 杀进程 + failed(timeout)', async () => {
    vi.useFakeTimers();
    try {
      const { child, flow } = setup({ waitMs: 1000 });
      const pending = flow.run();
      emitLines(child, DEVICE_FLOW_LINES.slice(0, 2));
      vi.advanceTimersByTime(1000);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      await expect(pending).resolves.toEqual({ state: 'failed', reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('T-KL7: 非 http(s)/超长 url、超长 code → failed(error)，不产生 device-flow', async () => {
    const cases = [
      ['Opening browser for Kimi device login: javascript:alert(1)'],
      [`Opening browser for Kimi device login: https://x.test/${'a'.repeat(2048)}`],
      [DEVICE_FLOW_LINES[0], `enter code: ${'A'.repeat(65)}`],
    ];
    for (const lines of cases) {
      const { child, flow } = setup();
      const onDeviceFlow = vi.fn();
      const pending = flow.run({ onDeviceFlow });
      emitLines(child, lines);
      child.emit('exit', 1, null);
      const outcome = await pending;
      expect(outcome.state).toBe('failed');
      expect(onDeviceFlow).not.toHaveBeenCalled();
    }
  });

  it('T-KL8: 无换行超长输出不无界增长（8 KiB 截断）', async () => {
    const { child, flow } = setup();
    const onLineMatched = vi.fn();
    const pending = flow.run({ onLineMatched });
    child.stderr.emit('data', Buffer.from('x'.repeat(64 * 1024)));
    child.stderr.emit('data', Buffer.from('\n'));
    expect(onLineMatched).not.toHaveBeenCalled();
    child.emit('exit', 1, null);
    await expect(pending).resolves.toMatchObject({ state: 'failed', reason: 'error' });
  });
});
