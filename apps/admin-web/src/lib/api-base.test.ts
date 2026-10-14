import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const STORAGE_KEY = 'zag:admin-api-base';

async function freshModule() {
  vi.resetModules();
  return import('./api-base');
}

function setWindowConfig(apiUrl?: string) {
  if (apiUrl === undefined) {
    delete (window as unknown as Record<string, unknown>).__ADMIN_CONFIG__;
  } else {
    (window as unknown as Record<string, unknown>).__ADMIN_CONFIG__ = { apiUrl };
  }
}

function okFetch() {
  return vi.fn().mockResolvedValue({ ok: true, status: 200 });
}

function failingFetch() {
  return vi.fn().mockResolvedValue({ ok: false, status: 500 });
}

describe('api-base', () => {
  beforeEach(() => {
    localStorage.clear();
    setWindowConfig(undefined);
    vi.stubEnv('VITE_ADMIN_API_URL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
    setWindowConfig(undefined);
  });

  it('T-F1①: localStorage wins over window config and env', async () => {
    localStorage.setItem(STORAGE_KEY, 'http://stored.example.com');
    setWindowConfig('http://window.example.com');
    vi.stubEnv('VITE_ADMIN_API_URL', 'http://env.example.com');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveAdminApiBase, getAdminApiBase } = await freshModule();

    await expect(resolveAdminApiBase()).resolves.toBe('http://stored.example.com');
    expect(getAdminApiBase()).toBe('http://stored.example.com');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('T-F1②: window config wins over env (no localStorage)', async () => {
    setWindowConfig('http://window.example.com');
    vi.stubEnv('VITE_ADMIN_API_URL', 'http://env.example.com');

    const { resolveAdminApiBase, getAdminApiBase } = await freshModule();

    await expect(resolveAdminApiBase()).resolves.toBe('http://window.example.com');
    expect(getAdminApiBase()).toBe('http://window.example.com');
  });

  it('T-F1③: env used when no localStorage/window config', async () => {
    vi.stubEnv('VITE_ADMIN_API_URL', 'http://env.example.com');

    const { resolveAdminApiBase, getAdminApiBase } = await freshModule();

    await expect(resolveAdminApiBase()).resolves.toBe('http://env.example.com');
    expect(getAdminApiBase()).toBe('http://env.example.com');
  });

  it('T-F1④: same-origin fallback (empty string) when nothing is configured', async () => {
    const { resolveAdminApiBase, getAdminApiBase } = await freshModule();

    await expect(resolveAdminApiBase()).resolves.toBe('');
    expect(getAdminApiBase()).toBe('');
  });

  it('resolveAdminApiBase caches in module state (no re-resolution)', async () => {
    vi.stubEnv('VITE_ADMIN_API_URL', 'http://env.example.com');

    const { resolveAdminApiBase } = await freshModule();
    const first = await resolveAdminApiBase();
    // 改变源之后仍返回缓存值
    vi.stubEnv('VITE_ADMIN_API_URL', 'http://other.example.com');
    const second = await resolveAdminApiBase();

    expect(first).toBe('http://env.example.com');
    expect(second).toBe('http://env.example.com');
  });

  it('setAdminApiBase persists on successful /health probe (normalizes trailing slash)', async () => {
    vi.stubGlobal('fetch', okFetch());

    const { setAdminApiBase, getAdminApiBase } = await freshModule();
    const ok = await setAdminApiBase('http://custom.example.com/');

    expect(ok).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('http://custom.example.com');
    expect(getAdminApiBase()).toBe('http://custom.example.com');
  });

  it('setAdminApiBase does not persist when the probe fails', async () => {
    vi.stubGlobal('fetch', failingFetch());

    const { setAdminApiBase, getAdminApiBase } = await freshModule();
    const ok = await setAdminApiBase('http://unreachable.example.com');

    expect(ok).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(getAdminApiBase()).toBe('');
  });

  it('setAdminApiBase probes <endpoint>/health', async () => {
    const fetchSpy = okFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const { setAdminApiBase } = await freshModule();
    await setAdminApiBase('http://custom.example.com');

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://custom.example.com/health',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('clearAdminApiBase removes stored value and restores default', async () => {
    vi.stubEnv('VITE_ADMIN_API_URL', 'http://env.example.com');
    vi.stubGlobal('fetch', okFetch());

    const { setAdminApiBase, clearAdminApiBase, getAdminApiBase, resolveAdminApiBase } = await freshModule();
    await setAdminApiBase('http://custom.example.com');
    expect(getAdminApiBase()).toBe('http://custom.example.com');

    clearAdminApiBase();

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(await resolveAdminApiBase()).toBe('http://env.example.com');
  });

  it('probeAdminApi aborts after 2s timeout and returns false', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }));

    const { probeAdminApi } = await freshModule();
    const promise = probeAdminApi('http://hang.example.com');
    await vi.advanceTimersByTimeAsync(2000);

    await expect(promise).resolves.toBe(false);
  });
});
