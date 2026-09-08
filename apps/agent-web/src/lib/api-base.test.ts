import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const CACHE_KEY = 'zag:api-base';
const CANDIDATE_1 = 'https://api.zag.fffdan.com';
const CANDIDATE_2 = 'https://zag-agent-api.fffdan.com';

async function freshModule() {
  vi.resetModules();
  return import('./api-base');
}

function mockFetchByCandidate(opts: {
  c1?: { ok: boolean; status: number; delay?: number; reject?: boolean };
  c2?: { ok: boolean; status: number; delay?: number; reject?: boolean };
}) {
  return vi.fn().mockImplementation((_url: string | Request | URL) => {
    const url = String(_url);
    const isC1 = url.includes(CANDIDATE_1);
    const cfg = isC1 ? opts.c1 : opts.c2;
    if (!cfg) return Promise.resolve({ ok: false, status: 404 });
    if (cfg.reject) return Promise.reject(new Error('network error'));
    if (cfg.delay) {
      return new Promise((resolve) =>
        setTimeout(() => resolve({ ok: cfg.ok, status: cfg.status }), cfg.delay),
      );
    }
    return Promise.resolve({ ok: cfg.ok, status: cfg.status });
  });
}

describe('api-base', () => {
  const origEnv = { ...import.meta.env };

  beforeEach(() => {
    sessionStorage.clear();
    (import.meta.env as Record<string, string>).VITE_API_URL = '';
  });

  afterEach(() => {
    Object.assign(import.meta.env, origEnv);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('T-B1: VITE_API_URL set → returns it directly, no fetch, no sessionStorage', async () => {
    (import.meta.env as Record<string, string>).VITE_API_URL = 'http://localhost:4000';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveApiBase } = await freshModule();
    const result = await resolveApiBase();

    expect(result).toBe('http://localhost:4000');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CACHE_KEY)).toBeNull();
  });

  it('T-B2: no env, sessionStorage cached → returns cache, no fetch', async () => {
    sessionStorage.setItem(CACHE_KEY, CANDIDATE_2);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { resolveApiBase } = await freshModule();
    const result = await resolveApiBase();

    expect(result).toBe(CANDIDATE_2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('T-B3: both 200, candidate1 faster → selects candidate1', async () => {
    vi.stubGlobal('fetch', mockFetchByCandidate({
      c1: { ok: true, status: 200, delay: 50 },
      c2: { ok: true, status: 200, delay: 200 },
    }));

    const { resolveApiBase } = await freshModule();
    const result = await resolveApiBase();

    expect(result).toBe(CANDIDATE_1);
    expect(sessionStorage.getItem(CACHE_KEY)).toBe(CANDIDATE_1);
  });

  it('T-B9: both 200, candidate2 faster → selects candidate2', async () => {
    vi.stubGlobal('fetch', mockFetchByCandidate({
      c1: { ok: true, status: 200, delay: 200 },
      c2: { ok: true, status: 200, delay: 50 },
    }));

    const { resolveApiBase } = await freshModule();
    const result = await resolveApiBase();

    expect(result).toBe(CANDIDATE_2);
    expect(sessionStorage.getItem(CACHE_KEY)).toBe(CANDIDATE_2);
  });

  it('T-B4: candidate1 rejects, candidate2 200 → selects candidate2', async () => {
    vi.stubGlobal('fetch', mockFetchByCandidate({
      c1: { reject: true, ok: false, status: 0 },
      c2: { ok: true, status: 200 },
    }));

    const { resolveApiBase } = await freshModule();
    const result = await resolveApiBase();

    expect(result).toBe(CANDIDATE_2);
    expect(sessionStorage.getItem(CACHE_KEY)).toBe(CANDIDATE_2);
  });

  it('T-B5: candidate1 returns 500, candidate2 200 → selects candidate2', async () => {
    vi.stubGlobal('fetch', mockFetchByCandidate({
      c1: { ok: false, status: 500 },
      c2: { ok: true, status: 200 },
    }));

    const { resolveApiBase } = await freshModule();
    const result = await resolveApiBase();

    expect(result).toBe(CANDIDATE_2);
    expect(sessionStorage.getItem(CACHE_KEY)).toBe(CANDIDATE_2);
  });

  it('T-B6: both candidates fail → returns API_CANDIDATES[0], no cache', async () => {
    vi.stubGlobal('fetch', mockFetchByCandidate({
      c1: { reject: true, ok: false, status: 0 },
      c2: { ok: false, status: 500 },
    }));

    const { resolveApiBase } = await freshModule();
    const result = await resolveApiBase();

    expect(result).toBe(CANDIDATE_1);
    expect(sessionStorage.getItem(CACHE_KEY)).toBeNull();
  });

  it('T-B7: both candidates hang → abort after timeout → returns fallback', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { resolveApiBase } = await freshModule();
    const promise = resolveApiBase();

    vi.advanceTimersByTime(2000);
    const result = await promise;

    expect(result).toBe(CANDIDATE_1);
    expect(sessionStorage.getItem(CACHE_KEY)).toBeNull();
  });

  it('T-B8: two sequential resolveApiBase() calls → second reuses first result', async () => {
    vi.stubGlobal('fetch', mockFetchByCandidate({
      c1: { ok: true, status: 200 },
      c2: { ok: true, status: 200 },
    }));

    const { resolveApiBase } = await freshModule();
    const r1 = await resolveApiBase();
    const r2 = await resolveApiBase();

    expect(r1).toBe(r2);
  });

  it('T-B10: one fast success, one hangs → returns without waiting for timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', mockFetchByCandidate({
      c1: { ok: false, status: 0 },
      c2: { ok: true, status: 200, delay: 50 },
    }));

    const { resolveApiBase } = await freshModule();
    const promise = resolveApiBase();

    vi.advanceTimersByTime(50);
    const result = await promise;

    expect(result).toBe(CANDIDATE_2);
    expect(sessionStorage.getItem(CACHE_KEY)).toBe(CANDIDATE_2);
  });
});
