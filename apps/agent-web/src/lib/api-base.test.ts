import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const AGENT_CACHE_KEY = 'zag:api-base';
const CONTROLLER_CACHE_KEY = 'zag:controller-api-base';
const AGENT_CANDIDATE_1 = 'https://api.zag.fffdan.com';
const AGENT_CANDIDATE_2 = 'https://zag-agent-api.fffdan.com';
const CONTROLLER_CANDIDATE_1 = 'https://ctrl.zag.fffdan.com';
const CONTROLLER_CANDIDATE_2 = 'https://zag-ctrl-api.fffdan.com';

interface ProbeCfg {
  ok: boolean;
  status: number;
  delay?: number;
  reject?: boolean;
  hang?: boolean;
}

async function freshModule() {
  vi.resetModules();
  return import('./api-base');
}

function mockFetchByUrl(map: Record<string, ProbeCfg>) {
  return vi.fn().mockImplementation(
    (_url: string | Request | URL, init?: { signal?: AbortSignal }) => {
      const url = String(_url);
      const origin = Object.keys(map).find((o) => url.startsWith(o)) ?? '';
      const cfg = map[origin];
      if (!cfg) return Promise.resolve({ ok: false, status: 404 });
      if (cfg.reject) return Promise.reject(new Error('network error'));
      if (cfg.hang) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
      if (cfg.delay) {
        return new Promise((resolve) =>
          setTimeout(() => resolve({ ok: cfg.ok, status: cfg.status }), cfg.delay),
        );
      }
      return Promise.resolve({ ok: cfg.ok, status: cfg.status });
    },
  );
}

function mockAgent(opts: { c1?: ProbeCfg; c2?: ProbeCfg }) {
  return mockFetchByUrl({
    [AGENT_CANDIDATE_1]: opts.c1 as ProbeCfg,
    [AGENT_CANDIDATE_2]: opts.c2 as ProbeCfg,
  });
}

function mockController(opts: { c1?: ProbeCfg; c2?: ProbeCfg }) {
  return mockFetchByUrl({
    [CONTROLLER_CANDIDATE_1]: opts.c1 as ProbeCfg,
    [CONTROLLER_CANDIDATE_2]: opts.c2 as ProbeCfg,
  });
}

describe('api-base', () => {
  const origEnv = { ...import.meta.env };

  beforeEach(() => {
    sessionStorage.clear();
    (import.meta.env as Record<string, string>).VITE_API_URL = '';
    (import.meta.env as Record<string, string>).VITE_CONTROLLER_API_URL = '';
  });

  afterEach(() => {
    Object.assign(import.meta.env, origEnv);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('agent-api', () => {
    it('T-B1: VITE_API_URL set → returns it directly, no fetch, no sessionStorage', async () => {
      (import.meta.env as Record<string, string>).VITE_API_URL = 'http://localhost:4000';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const { resolveApiBase } = await freshModule();
      const result = await resolveApiBase();

      expect(result).toBe('http://localhost:4000');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(AGENT_CACHE_KEY)).toBeNull();
    });

    it('T-B2: no env, sessionStorage cached → returns cache, no fetch', async () => {
      sessionStorage.setItem(AGENT_CACHE_KEY, AGENT_CANDIDATE_2);
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const { resolveApiBase } = await freshModule();
      const result = await resolveApiBase();

      expect(result).toBe(AGENT_CANDIDATE_2);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('T-B3: both 200, candidate1 faster → selects candidate1', async () => {
      vi.stubGlobal('fetch', mockAgent({
        c1: { ok: true, status: 200, delay: 50 },
        c2: { ok: true, status: 200, delay: 200 },
      }));

      const { resolveApiBase } = await freshModule();
      const result = await resolveApiBase();

      expect(result).toBe(AGENT_CANDIDATE_1);
      expect(sessionStorage.getItem(AGENT_CACHE_KEY)).toBe(AGENT_CANDIDATE_1);
    });

    it('T-B9: both 200, candidate2 faster → selects candidate2', async () => {
      vi.stubGlobal('fetch', mockAgent({
        c1: { ok: true, status: 200, delay: 200 },
        c2: { ok: true, status: 200, delay: 50 },
      }));

      const { resolveApiBase } = await freshModule();
      const result = await resolveApiBase();

      expect(result).toBe(AGENT_CANDIDATE_2);
      expect(sessionStorage.getItem(AGENT_CACHE_KEY)).toBe(AGENT_CANDIDATE_2);
    });

    it('T-B4: candidate1 rejects, candidate2 200 → selects candidate2', async () => {
      vi.stubGlobal('fetch', mockAgent({
        c1: { reject: true, ok: false, status: 0 },
        c2: { ok: true, status: 200 },
      }));

      const { resolveApiBase } = await freshModule();
      const result = await resolveApiBase();

      expect(result).toBe(AGENT_CANDIDATE_2);
      expect(sessionStorage.getItem(AGENT_CACHE_KEY)).toBe(AGENT_CANDIDATE_2);
    });

    it('T-B5: candidate1 returns 500, candidate2 200 → selects candidate2', async () => {
      vi.stubGlobal('fetch', mockAgent({
        c1: { ok: false, status: 500 },
        c2: { ok: true, status: 200 },
      }));

      const { resolveApiBase } = await freshModule();
      const result = await resolveApiBase();

      expect(result).toBe(AGENT_CANDIDATE_2);
      expect(sessionStorage.getItem(AGENT_CACHE_KEY)).toBe(AGENT_CANDIDATE_2);
    });

    it('T-B6: both candidates fail → returns API_CANDIDATES[0], no cache', async () => {
      vi.stubGlobal('fetch', mockAgent({
        c1: { reject: true, ok: false, status: 0 },
        c2: { ok: false, status: 500 },
      }));

      const { resolveApiBase } = await freshModule();
      const result = await resolveApiBase();

      expect(result).toBe(AGENT_CANDIDATE_1);
      expect(sessionStorage.getItem(AGENT_CACHE_KEY)).toBeNull();
    });

    it('T-B7: both candidates hang → abort after timeout → returns fallback', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', mockAgent({
        c1: { hang: true, ok: false, status: 0 },
        c2: { hang: true, ok: false, status: 0 },
      }));

      const { resolveApiBase } = await freshModule();
      const promise = resolveApiBase();

      vi.advanceTimersByTime(2000);
      const result = await promise;

      expect(result).toBe(AGENT_CANDIDATE_1);
      expect(sessionStorage.getItem(AGENT_CACHE_KEY)).toBeNull();
    });

    it('T-B8: two sequential resolveApiBase() calls → second reuses first result', async () => {
      const fetchMock = mockAgent({
        c1: { ok: true, status: 200 },
        c2: { ok: true, status: 200 },
      });
      vi.stubGlobal('fetch', fetchMock);

      const { resolveApiBase } = await freshModule();
      const r1 = await resolveApiBase();
      const callsAfterFirst = fetchMock.mock.calls.length;
      const r2 = await resolveApiBase();

      expect(r1).toBe(r2);
      expect(callsAfterFirst).toBe(2);
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    });

    it('T-B10: one fast success, one hangs → returns without waiting for timeout', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', mockAgent({
        c1: { hang: true, ok: false, status: 0 },
        c2: { ok: true, status: 200, delay: 50 },
      }));

      const { resolveApiBase } = await freshModule();
      const promise = resolveApiBase();

      vi.advanceTimersByTime(50);
      const result = await promise;

      expect(result).toBe(AGENT_CANDIDATE_2);
      expect(sessionStorage.getItem(AGENT_CACHE_KEY)).toBe(AGENT_CANDIDATE_2);
    });
  });

  describe('controller-api', () => {
    it('T-C1: VITE_CONTROLLER_API_URL set → returns it directly, no fetch, no sessionStorage', async () => {
      (import.meta.env as Record<string, string>).VITE_CONTROLLER_API_URL = 'http://localhost:4001';
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const { resolveControllerApiBase } = await freshModule();
      const result = await resolveControllerApiBase();

      expect(result).toBe('http://localhost:4001');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(CONTROLLER_CACHE_KEY)).toBeNull();
    });

    it('T-C2: no env, sessionStorage cached → returns cache, no fetch', async () => {
      sessionStorage.setItem(CONTROLLER_CACHE_KEY, CONTROLLER_CANDIDATE_2);
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const { resolveControllerApiBase } = await freshModule();
      const result = await resolveControllerApiBase();

      expect(result).toBe(CONTROLLER_CANDIDATE_2);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('T-C3: both 200, ctrl.zag faster → selects ctrl.zag', async () => {
      vi.stubGlobal('fetch', mockController({
        c1: { ok: true, status: 200, delay: 30 },
        c2: { ok: true, status: 200, delay: 200 },
      }));

      const { resolveControllerApiBase } = await freshModule();
      const result = await resolveControllerApiBase();

      expect(result).toBe(CONTROLLER_CANDIDATE_1);
      expect(sessionStorage.getItem(CONTROLLER_CACHE_KEY)).toBe(CONTROLLER_CANDIDATE_1);
    });

    it('T-C4: ctrl.zag rejects, global 200 → selects global', async () => {
      vi.stubGlobal('fetch', mockController({
        c1: { reject: true, ok: false, status: 0 },
        c2: { ok: true, status: 200 },
      }));

      const { resolveControllerApiBase } = await freshModule();
      const result = await resolveControllerApiBase();

      expect(result).toBe(CONTROLLER_CANDIDATE_2);
      expect(sessionStorage.getItem(CONTROLLER_CACHE_KEY)).toBe(CONTROLLER_CANDIDATE_2);
    });

    it('T-C5: both fail → returns candidates[0], no cache', async () => {
      vi.stubGlobal('fetch', mockController({
        c1: { reject: true, ok: false, status: 0 },
        c2: { ok: false, status: 500 },
      }));

      const { resolveControllerApiBase } = await freshModule();
      const result = await resolveControllerApiBase();

      expect(result).toBe(CONTROLLER_CANDIDATE_1);
      expect(sessionStorage.getItem(CONTROLLER_CACHE_KEY)).toBeNull();
    });

    it('T-C6: both hang → abort after timeout → returns fallback', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', mockController({
        c1: { hang: true, ok: false, status: 0 },
        c2: { hang: true, ok: false, status: 0 },
      }));

      const { resolveControllerApiBase } = await freshModule();
      const promise = resolveControllerApiBase();

      vi.advanceTimersByTime(2000);
      const result = await promise;

      expect(result).toBe(CONTROLLER_CANDIDATE_1);
      expect(sessionStorage.getItem(CONTROLLER_CACHE_KEY)).toBeNull();
    });

    it('T-C7: agent and controller resolve independently → different winners, separate caches', async () => {
      vi.stubGlobal('fetch', mockFetchByUrl({
        [AGENT_CANDIDATE_1]: { ok: true, status: 200, delay: 200 },
        [AGENT_CANDIDATE_2]: { ok: true, status: 200, delay: 30 },
        [CONTROLLER_CANDIDATE_1]: { ok: true, status: 200, delay: 30 },
        [CONTROLLER_CANDIDATE_2]: { ok: true, status: 200, delay: 200 },
      }));

      const { resolveApiBase, resolveControllerApiBase } = await freshModule();
      const [agent, controller] = await Promise.all([
        resolveApiBase(),
        resolveControllerApiBase(),
      ]);

      expect(agent).toBe(AGENT_CANDIDATE_2);
      expect(controller).toBe(CONTROLLER_CANDIDATE_1);
      expect(sessionStorage.getItem(AGENT_CACHE_KEY)).toBe(AGENT_CANDIDATE_2);
      expect(sessionStorage.getItem(CONTROLLER_CACHE_KEY)).toBe(CONTROLLER_CANDIDATE_1);
    });

    it('T-C8: two sequential resolveControllerApiBase() calls → second reuses result', async () => {
      const fetchMock = mockController({
        c1: { ok: true, status: 200 },
        c2: { ok: true, status: 200 },
      });
      vi.stubGlobal('fetch', fetchMock);

      const { resolveControllerApiBase } = await freshModule();
      const r1 = await resolveControllerApiBase();
      const callsAfterFirst = fetchMock.mock.calls.length;
      const r2 = await resolveControllerApiBase();

      expect(r1).toBe(r2);
      expect(callsAfterFirst).toBe(2);
      expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
    });

    it('T-C9: getApiBase() does not resolve controller-api', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const mod = await freshModule();
      expect(mod.getApiBase()).toBe('');
      expect('getControllerApiBase' in mod).toBe(false);
    });
  });
});
