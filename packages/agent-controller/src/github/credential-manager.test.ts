import { describe, it, expect, vi } from 'vitest';
import {
  GithubCredentialManager,
  REFRESH_INTERVAL_MS,
  EXPIRY_SKEW_MS,
  BACKOFF_MS,
} from './credential-manager.js';

const TOKEN = 'ghs_credential_manager_secret';
const BASE_ENV: NodeJS.ProcessEnv = {
  ZAG_AGENT_API_ENDPOINT: 'http://agent-api:8002/',
  ZAG_CONTROLLER_ID: 'controller-123',
  ZAG_HOST_KEY: 'zag_k_1_host_secret',
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

const EXPIRES_AT = '2026-10-22T12:00:00.000Z';

describe('GithubCredentialManager', () => {
  it('T-CM1: first refresh posts with the host key and writes gh credentials before returning', async () => {
    const fetchFn = fakeFetch(async () => jsonResponse({ token: TOKEN, expiresAt: EXPIRES_AT }));
    const writeGhAuth = vi.fn(async () => {});
    const callOrder: string[] = [];
    fetchFn.mockImplementation(async () => {
      callOrder.push('fetch');
      return jsonResponse({ token: TOKEN, expiresAt: EXPIRES_AT });
    });
    writeGhAuth.mockImplementation(async () => {
      callOrder.push('write');
    });

    const manager = new GithubCredentialManager({
      env: BASE_ENV,
      fetch: fetchFn,
      writeGhAuth,
      log: () => {},
    });

    const result = await manager.refreshNow();

    expect(result.ok).toBe(true);
    expect(result.expiresAt).toEqual(new Date(EXPIRES_AT));
    expect(writeGhAuth).toHaveBeenCalledWith(TOKEN);
    expect(callOrder).toEqual(['fetch', 'write']);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'http://agent-api:8002/internal/cloud-hosts/controller-123/github-credential',
    );
    expect(init).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer zag_k_1_host_secret' },
    });
    expect(init).not.toHaveProperty('body');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('T-CM2: 404 means no binding: no write, no error log, returns no-binding', async () => {
    const fetchFn = fakeFetch(async () => new Response('', { status: 404 }));
    const writeGhAuth = vi.fn(async () => {});
    const logs: string[] = [];

    const manager = new GithubCredentialManager({
      env: BASE_ENV,
      fetch: fetchFn,
      writeGhAuth,
      log: (message) => logs.push(message),
    });

    const result = await manager.refreshNow();

    expect(result).toEqual({ ok: false, error: 'no-binding' });
    expect(writeGhAuth).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).not.toMatch(/error|失败|warn/i);
  });

  it('T-CM3: 401 retries with 1/2/4 minute backoff and eventually returns a readable error', async () => {
    const fetchFn = fakeFetch(async () => new Response('', { status: 401 }));
    const delays: number[] = [];
    const logs: string[] = [];
    const writeGhAuth = vi.fn(async () => {});

    const manager = new GithubCredentialManager({
      env: BASE_ENV,
      fetch: fetchFn,
      writeGhAuth,
      log: (message) => logs.push(message),
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    const result = await manager.refreshNow();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('凭据无效');
    expect(delays).toEqual([...BACKOFF_MS]);
    expect(fetchFn).toHaveBeenCalledTimes(BACKOFF_MS.length + 1);
    expect(writeGhAuth).not.toHaveBeenCalled();
    expect(logs.join('\n')).not.toContain(TOKEN);
  });

  it('T-CM4: schedules every 50 minutes, or earlier when the token expires within the skew', async () => {
    const now = Date.parse('2026-10-22T10:00:00.000Z');
    const fetchFn = fakeFetch(async () =>
      jsonResponse({ token: TOKEN, expiresAt: new Date(now + 2 * 60 * 60 * 1000).toISOString() }),
    );
    const scheduler = fakeScheduler();

    const manager = new GithubCredentialManager({
      env: BASE_ENV,
      fetch: fetchFn,
      writeGhAuth: async () => {},
      now: () => now,
      log: () => {},
      setTimeout: scheduler.setTimeoutFn,
    });

    manager.start();
    await vi.waitFor(() => expect(scheduler.timers).toHaveLength(1));
    expect(scheduler.timers[0].delay).toBe(REFRESH_INTERVAL_MS);

    // 触发一次定时续期：再申请一次并重新排期
    scheduler.timers[0].fn();
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(scheduler.timers).toHaveLength(2));

    // token 剩余 40 分钟 → 到期前 10 分钟（30 分钟后）优先于 50 分钟
    const earlyScheduler = fakeScheduler();
    const earlyFetch = fakeFetch(async () =>
      jsonResponse({ token: TOKEN, expiresAt: new Date(now + 40 * 60 * 1000).toISOString() }),
    );
    const earlyManager = new GithubCredentialManager({
      env: BASE_ENV,
      fetch: earlyFetch,
      writeGhAuth: async () => {},
      now: () => now,
      log: () => {},
      setTimeout: earlyScheduler.setTimeoutFn,
    });
    earlyManager.start();
    await vi.waitFor(() => expect(earlyScheduler.timers).toHaveLength(1));
    expect(earlyScheduler.timers[0].delay).toBe(30 * 60 * 1000);

    manager.stop();
    earlyManager.stop();
  });

  it('T-CM9 (REPRO): 续期拿到仅剩 10 分钟的 token 时必须在到期前再次续期，而不是再等 50 分钟', async () => {
    const t0 = Date.parse('2026-10-22T10:00:00.000Z');
    let now = t0;
    // 复现服务端进程内缓存：首次签发 60 分钟有效的 token，50 分钟后续期仍返回同一枚
    // （命中缓存，剩余有效期只剩 10 分钟）。
    const minted = new Date(t0 + 60 * 60 * 1000).toISOString();
    const fetchFn = fakeFetch(async () => jsonResponse({ token: TOKEN, expiresAt: minted }));
    const scheduler = fakeScheduler();

    const manager = new GithubCredentialManager({
      env: BASE_ENV,
      fetch: fetchFn,
      writeGhAuth: async () => {},
      now: () => now,
      log: () => {},
      setTimeout: scheduler.setTimeoutFn,
    });

    manager.start();
    await vi.waitFor(() => expect(scheduler.timers).toHaveLength(1));
    expect(scheduler.timers[0].delay).toBe(REFRESH_INTERVAL_MS);

    // 50 分钟后续期：服务端返回缓存 token（仅剩 10 分钟）
    now = t0 + REFRESH_INTERVAL_MS;
    scheduler.timers[0].fn();
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(scheduler.timers).toHaveLength(2));

    // 期望：下一次续期必须早于 token 过期（留出 EXPIRY_SKEW_MS 余量）。
    // 实际：beforeExpiry 计算为 0 → 回落到 50 分钟，token 过期 40 分钟后才续期。
    expect(now + scheduler.timers[1].delay).toBeLessThanOrEqual(
      t0 + 60 * 60 * 1000 - EXPIRY_SKEW_MS,
    );

    manager.stop();
  });

  it('T-CM10 (REPRO): 收到即将过期的 token 时短间隔重试，而不是 50 分钟后再来', async () => {
    const t0 = Date.parse('2026-10-22T10:00:00.000Z');
    let now = t0;
    const writeGhAuth = vi.fn(async () => {});
    // 服务端返回的 token 在 1 分钟后过期（已是「续期也救不回来」的临界值）
    const fetchFn = fakeFetch(async () =>
      jsonResponse({ token: TOKEN, expiresAt: new Date(t0 + 60 * 1000).toISOString() }),
    );
    const scheduler = fakeScheduler();

    const manager = new GithubCredentialManager({
      env: BASE_ENV,
      fetch: fetchFn,
      writeGhAuth,
      now: () => now,
      log: () => {},
      setTimeout: scheduler.setTimeoutFn,
    });

    manager.start();
    await vi.waitFor(() => expect(scheduler.timers).toHaveLength(1));

    // 期望：近过期 token 不应按 50 分钟排期，而是短间隔重试拿新凭据。
    expect(scheduler.timers[0].delay).toBeLessThan(REFRESH_INTERVAL_MS);

    manager.stop();
  });

  it('T-CM11: 非 401/403/404 的续期失败必须留下脱敏日志（5xx / 非法 JSON / 网络错误不再静默）', async () => {
    const scenarios: Array<() => Promise<Response>> = [
      async () => new Response('boom', { status: 500 }),
      async () =>
        new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
      async () => {
        throw new Error('ECONNREFUSED');
      },
    ];

    for (const scenario of scenarios) {
      const logs: string[] = [];
      const manager = new GithubCredentialManager({
        env: BASE_ENV,
        fetch: fakeFetch(scenario),
        writeGhAuth: async () => {},
        log: (message) => logs.push(message),
      });

      const result = await manager.refreshNow();

      expect(result.ok).toBe(false);
      const joined = logs.join('\n');
      expect(joined).toContain('[GithubCredential] 凭据续期失败');
      expect(joined).not.toContain(TOKEN);
    }
  });

  it('T-CM12: 进入近过期区首次立即重试、其后按短间隔退避，并留下不含 token 的告警日志', async () => {
    const t0 = Date.parse('2026-10-22T10:00:00.000Z');
    let now = t0;
    const logs: string[] = [];
    // 服务端持续返回近过期 token（复现 R1 未修复时的缓存命中）
    const minted = new Date(t0 + 60 * 60 * 1000).toISOString();
    const fetchFn = fakeFetch(async () => jsonResponse({ token: TOKEN, expiresAt: minted }));
    const scheduler = fakeScheduler();

    const manager = new GithubCredentialManager({
      env: BASE_ENV,
      fetch: fetchFn,
      writeGhAuth: async () => {},
      now: () => now,
      log: (message) => logs.push(message),
      setTimeout: scheduler.setTimeoutFn,
    });

    manager.start();
    await vi.waitFor(() => expect(scheduler.timers).toHaveLength(1));

    // 50 分钟后续期仍拿到同一枚只剩 10 分钟的 token → 进入近过期区
    now = t0 + REFRESH_INTERVAL_MS;
    scheduler.timers[0].fn();
    await vi.waitFor(() => expect(scheduler.timers).toHaveLength(2));
    // 首次发现已到/已过续期余量：立即重试，绝不排到 token 过期之后
    expect(scheduler.timers[1].delay).toBe(0);

    scheduler.timers[1].fn();
    await vi.waitFor(() => expect(scheduler.timers).toHaveLength(3));
    // 服务端仍返回近过期 token → 退到短间隔重试（60s），避免热循环打爆 agent-api
    expect(scheduler.timers[2].delay).toBe(60_000);

    const joined = logs.join('\n');
    expect(joined).toContain('[GithubCredential] 凭据剩余有效期不足');
    expect(joined).not.toContain(TOKEN);

    manager.stop();
  });

  it('T-CM5: concurrent refreshNow calls are serialized into a single request', async () => {
    let release!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchFn = fakeFetch(() => gate);
    const writeGhAuth = vi.fn(async () => {});

    const manager = new GithubCredentialManager({
      env: BASE_ENV,
      fetch: fetchFn,
      writeGhAuth,
      log: () => {},
    });

    const first = manager.refreshNow();
    const second = manager.refreshNow();
    release(jsonResponse({ token: TOKEN, expiresAt: EXPIRES_AT }));

    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(writeGhAuth).toHaveBeenCalledTimes(1);
  });

  it('T-CM6: missing env disables startup with a warn that only lists variable names', async () => {
    const fetchFn = fakeFetch(async () => jsonResponse({}));
    const logs: string[] = [];
    const manager = new GithubCredentialManager({
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

  it('T-CM7: invalid JSON and network failures produce readable errors without throwing', async () => {
    const invalidJson = fakeFetch(
      async () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const manager = new GithubCredentialManager({
      env: BASE_ENV,
      fetch: invalidJson,
      writeGhAuth: async () => {},
      log: () => {},
    });
    const invalid = await manager.refreshNow();
    expect(invalid.ok).toBe(false);
    expect(invalid.error).toContain('合法 JSON');

    const network = fakeFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const networkManager = new GithubCredentialManager({
      env: BASE_ENV,
      fetch: network,
      writeGhAuth: async () => {},
      log: () => {},
    });
    const failed = await networkManager.refreshNow();
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('ECONNREFUSED');
  });

  it('T-CM8: logs and returned errors never contain the token', async () => {
    const logs: string[] = [];
    const fetchFn = fakeFetch(async () => jsonResponse({ token: TOKEN, expiresAt: EXPIRES_AT }));
    const manager = new GithubCredentialManager({
      env: BASE_ENV,
      fetch: fetchFn,
      writeGhAuth: async () => {
        throw new Error(`unable to write ${TOKEN}`);
      },
      log: (message) => logs.push(message),
    });

    const result = await manager.refreshNow();

    expect(result.ok).toBe(false);
    expect(logs.join('\n')).not.toContain(TOKEN);
    // writeGhAuth 的实现负责脱敏；管理器不额外拼接 token
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
