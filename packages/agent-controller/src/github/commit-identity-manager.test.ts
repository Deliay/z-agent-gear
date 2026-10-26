import { describe, it, expect, vi } from 'vitest';
import {
  CommitIdentityManager,
  REFRESH_INTERVAL_MS,
  BACKOFF_MS,
  type CommitIdentityApplier,
  type CommitIdentityRefreshResult,
} from './commit-identity-manager.js';

const HOST_KEY = 'zag_k_1_host_secret';
const BASE_ENV: NodeJS.ProcessEnv = {
  ZAG_AGENT_API_ENDPOINT: 'http://agent-api:8002/',
  ZAG_CONTROLLER_ID: 'controller-123',
  ZAG_HOST_KEY: HOST_KEY,
};

const HUMAN = { name: 'Alice', email: '1001+alice@users.noreply.github.com' };
const CO_AUTHOR = {
  name: 'Alice',
  email: '1001+alice@users.noreply.github.com',
  coAuthorName: 'zag-bot[bot]',
  coAuthorEmail: '123456+zag-bot[bot]@users.noreply.github.com',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(handler: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  return vi.fn(handler) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function fakeApplier() {
  const apply = vi.fn(async () => {});
  const remove = vi.fn(async () => {});
  return { apply, remove } satisfies CommitIdentityApplier;
}

interface ScheduledTimer {
  fn: () => void;
  delay: number;
  handle: ReturnType<typeof setTimeout>;
}

function fakeScheduler() {
  const timers: ScheduledTimer[] = [];
  const setTimeoutFn = ((fn: () => void, delay: number) => {
    const handle = setTimeout(() => {}, 0);
    handle.unref();
    timers.push({ fn, delay, handle });
    return handle;
  }) as unknown as typeof setTimeout;
  return { timers, setTimeoutFn };
}

describe('CommitIdentityManager', () => {
  it('T-CIM1: first refresh posts with the host key and applies the returned identity', async () => {
    const fetchFn = fakeFetch(async () => jsonResponse({ mode: 'co_author', ...CO_AUTHOR }));
    const applier = fakeApplier();
    const logs: string[] = [];
    const manager = new CommitIdentityManager({
      env: BASE_ENV,
      fetch: fetchFn,
      applier,
      log: (message) => logs.push(message),
    });

    const result = await manager.refreshNow();

    expect(result).toEqual({ ok: true, mode: 'co_author' });
    expect(applier.apply).toHaveBeenCalledWith('co_author', CO_AUTHOR);
    expect(applier.remove).not.toHaveBeenCalled();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://agent-api:8002/internal/cloud-hosts/controller-123/commit-identity');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { Authorization: `Bearer ${HOST_KEY}` },
    });
    expect(init).not.toHaveProperty('body');
    expect(init.signal).toBeInstanceOf(AbortSignal);

    // 日志不含身份值（邮箱 / 姓名）与 host key
    const output = logs.join('\n');
    expect(output).toContain('co_author');
    expect(output).not.toContain('Alice');
    expect(output).not.toContain('alice@users.noreply.github.com');
    expect(output).not.toContain(HOST_KEY);
  });

  it('T-CIM2: mode=unset removes the managed configuration instead of applying it', async () => {
    const fetchFn = fakeFetch(async () => jsonResponse({ mode: 'unset' }));
    const applier = fakeApplier();
    const manager = new CommitIdentityManager({
      env: BASE_ENV,
      fetch: fetchFn,
      applier,
      log: () => {},
    });

    const result = await manager.refreshNow();

    expect(result).toEqual({ ok: true, mode: 'unset' });
    expect(applier.remove).toHaveBeenCalledTimes(1);
    expect(applier.apply).not.toHaveBeenCalled();
  });

  it('T-CIM3: refreshes immediately on start and then every 50 minutes with an unref timer', async () => {
    const fetchFn = fakeFetch(async () => jsonResponse({ mode: 'human_only', ...HUMAN }));
    const applier = fakeApplier();
    const scheduler = fakeScheduler();
    const manager = new CommitIdentityManager({
      env: BASE_ENV,
      fetch: fetchFn,
      applier,
      log: () => {},
      setTimeout: scheduler.setTimeoutFn,
    });

    manager.start();
    await vi.waitFor(() => expect(scheduler.timers).toHaveLength(1));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(applier.apply).toHaveBeenCalledTimes(1);
    expect(scheduler.timers[0]!.delay).toBe(REFRESH_INTERVAL_MS);
    expect(REFRESH_INTERVAL_MS).toBe(50 * 60 * 1000);

    scheduler.timers[0]!.fn();
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(scheduler.timers).toHaveLength(2));

    manager.stop();
    expect(scheduler.timers[1]!.handle.hasRef()).toBe(false);
  });

  it('T-CIM4: 401/403 retries with 1/2/4 minute backoff and keeps the current configuration', async () => {
    const fetchFn = fakeFetch(async () => new Response('', { status: 401 }));
    const applier = fakeApplier();
    const delays: number[] = [];
    const manager = new CommitIdentityManager({
      env: BASE_ENV,
      fetch: fetchFn,
      applier,
      log: () => {},
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const result = await manager.refreshNow();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('提交身份');
    expect(delays).toEqual([...BACKOFF_MS]);
    expect(fetchFn).toHaveBeenCalledTimes(BACKOFF_MS.length + 1);
    expect(applier.apply).not.toHaveBeenCalled();
    expect(applier.remove).not.toHaveBeenCalled();
  });

  it('T-CIM5: concurrent refreshNow calls are merged into a single request', async () => {
    let release!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchFn = fakeFetch(() => gate);
    const applier = fakeApplier();
    const manager = new CommitIdentityManager({
      env: BASE_ENV,
      fetch: fetchFn,
      applier,
      log: () => {},
    });

    const first = manager.refreshNow();
    const second = manager.refreshNow();
    release(jsonResponse({ mode: 'human_only', ...HUMAN }));

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(applier.apply).toHaveBeenCalledTimes(1);
  });

  it('T-CIM6: missing env disables startup with a warn that only lists variable names', async () => {
    const fetchFn = fakeFetch(async () => jsonResponse({ mode: 'unset' }));
    const logs: string[] = [];
    const manager = new CommitIdentityManager({
      env: { ZAG_HOST_KEY: 'should-not-appear' },
      fetch: fetchFn,
      log: (message) => logs.push(message),
    });

    manager.start();

    expect(fetchFn).not.toHaveBeenCalled();
    const output = logs.join('\n');
    expect(output).toContain('ZAG_AGENT_API_ENDPOINT');
    expect(output).toContain('ZAG_CONTROLLER_ID');
    expect(output).not.toContain('should-not-appear');
    await expect(manager.refreshNow()).resolves.toEqual({ ok: false, error: 'disabled' });
  });

  it('T-CIM7: invalid JSON, invalid mode and network failures produce readable errors without crashing', async () => {
    const invalidJson = fakeFetch(
      async () =>
        new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const applier = fakeApplier();
    const manager = new CommitIdentityManager({
      env: BASE_ENV,
      fetch: invalidJson,
      applier,
      log: () => {},
    });
    const invalid = await manager.refreshNow();
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain('合法 JSON');

    const invalidMode = fakeFetch(async () => jsonResponse({ mode: 'everyone' }));
    const modeManager = new CommitIdentityManager({
      env: BASE_ENV,
      fetch: invalidMode,
      applier,
      log: () => {},
    });
    const modeResult = await modeManager.refreshNow();
    expect(modeResult.ok).toBe(false);
    expect(modeResult.error).toContain('mode');

    const network = fakeFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const networkManager = new CommitIdentityManager({
      env: BASE_ENV,
      fetch: network,
      applier,
      log: () => {},
    });
    const failed = await networkManager.refreshNow();
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('ECONNREFUSED');

    // 失败一律保留现状：不 apply、不 remove
    expect(applier.apply).not.toHaveBeenCalled();
    expect(applier.remove).not.toHaveBeenCalled();
  });

  it('T-CIM8: logs and returned errors never contain the host key', async () => {
    const logs: string[] = [];
    const fetchFn = fakeFetch(async () => jsonResponse({ mode: 'co_author', ...CO_AUTHOR }));
    const applier = fakeApplier();
    applier.apply.mockImplementation(async () => {
      throw new Error(`write failed with ${HOST_KEY}`);
    });
    const manager = new CommitIdentityManager({
      env: BASE_ENV,
      fetch: fetchFn,
      applier,
      log: (message) => logs.push(message),
    });

    const result: CommitIdentityRefreshResult = await manager.refreshNow();

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(HOST_KEY);
    expect(logs.join('\n')).not.toContain(HOST_KEY);
    expect(logs.join('\n')).not.toContain(CO_AUTHOR.coAuthorEmail);
  });
});
