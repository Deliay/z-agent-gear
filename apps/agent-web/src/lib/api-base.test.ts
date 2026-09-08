import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const CACHE_KEY = 'zag:api-base';
const CANDIDATE_1 = 'https://api.zag.fffdan.com';
const CANDIDATE_2 = 'https://zag-agent-api.fffdan.com';

async function freshModule() {
  vi.resetModules();
  return import('./api-base');
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

  it('T-B3: no env, no cache, both 200, candidate1 faster → selects candidate1', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200 }), 50)))
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200 }), 200)));
    vi.stubGlobal('fetch', fetchMock);

    const { resolveApiBase } = await freshModule();
    const result = await resolveApiBase();

    expect(result).toBe(CANDIDATE_1);
    expect(sessionStorage.getItem(CACHE_KEY)).toBe(CANDIDATE_1);
  });

  it('T-B4: candidate1 rejects, candidate2 200 → selects candidate2', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('network error')))
      .mockImplementationOnce(() => Promise.resolve({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { resolveApiBase } = await freshModule();
    const result = await resolveApiBase();

    expect(result).toBe(CANDIDATE_2);
    expect(sessionStorage.getItem(CACHE_KEY)).toBe(CANDIDATE_2);
  });

  it('T-B5: candidate1 returns 500, candidate2 200 → selects candidate2', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve({ ok: false, status: 500 }))
      .mockImplementationOnce(() => Promise.resolve({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { resolveApiBase } = await freshModule();
    const result = await resolveApiBase();

    expect(result).toBe(CANDIDATE_2);
    expect(sessionStorage.getItem(CACHE_KEY)).toBe(CANDIDATE_2);
  });

  it('T-B6: both candidates fail → returns API_CANDIDATES[0], no cache', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('fail')))
      .mockImplementationOnce(() => Promise.resolve({ ok: false, status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

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
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve({ ok: true, status: 200 }))
      .mockImplementationOnce(() => Promise.resolve({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { resolveApiBase } = await freshModule();
    const r1 = await resolveApiBase();
    const r2 = await resolveApiBase();

    expect(r1).toBe(r2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
