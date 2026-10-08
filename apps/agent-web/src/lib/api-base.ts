const AGENT_CANDIDATES = ['https://api.zag.fffdan.com', 'https://zag-agent-api.fffdan.com'];
const CONTROLLER_CANDIDATES = ['https://ctrl.zag.fffdan.com', 'https://zag-ctrl-api.fffdan.com'];
const AGENT_LOCAL_FALLBACK = 'http://localhost:4000';
const CONTROLLER_LOCAL_FALLBACK = 'http://localhost:4001';
const AGENT_CACHE_KEY = 'zag:api-base';
const CONTROLLER_CACHE_KEY = 'zag:controller-api-base';
const PROBE_TIMEOUT_MS = 2000;

interface ResolverState {
  cached: string | null;
  // 最近一次解析结果（成功或回落均写入），仅用于同步入口 getApiBase() 与异步入口保持一致；
  // 与 cached 的区别：cached 会短路后续解析并写 sessionStorage，lastResolved 不会。
  lastResolved: string | null;
  pending: Promise<string> | null;
}

interface ResolveOptions {
  candidates: readonly string[];
  envUrl: string | undefined;
  cacheKey: string;
  fallback: string;
  devFallback: string;
  state: ResolverState;
}

const agentState: ResolverState = { cached: null, lastResolved: null, pending: null };
const controllerState: ResolverState = { cached: null, lastResolved: null, pending: null };

function readCache(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    // 隐私模式/沙箱下 sessionStorage 可能抛 SecurityError，降级为无缓存。
    return null;
  }
}

function writeCache(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // 无法持久化时忽略，内存态缓存仍然生效。
  }
}

function probeCandidate(origin: string, signal: AbortSignal): Promise<string> {
  return fetch(`${origin}/health`, { signal }).then((res) => {
    if (!res.ok) throw new Error(`${res.status}`);
    return origin;
  });
}

async function resolveBase(options: ResolveOptions): Promise<string> {
  const { candidates, envUrl, cacheKey, fallback, devFallback, state } = options;

  if (state.cached) return state.cached;

  if (envUrl) {
    state.cached = envUrl;
    state.lastResolved = envUrl;
    return envUrl;
  }

  // 本地开发（vite dev）且未显式注入 env：跳过线上候选探测，回落本地服务。
  // 避免 `npm run dev` 手动启动时误读写生产数据，并保证离线/内网可用。
  if (import.meta.env.DEV) {
    state.cached = devFallback;
    state.lastResolved = devFallback;
    return devFallback;
  }

  const stored = readCache(cacheKey);
  if (stored) {
    state.cached = stored;
    state.lastResolved = stored;
    return stored;
  }

  // 并发调用共享同一次在途探测，避免首屏多消费点重复请求。
  if (state.pending) return state.pending;

  const pending = (async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    try {
      const winner = await Promise.any(
        candidates.map((origin) => probeCandidate(origin, controller.signal)),
      );
      controller.abort();
      state.cached = winner;
      state.lastResolved = winner;
      writeCache(cacheKey, winner);
      return winner;
    } catch {
      // 全部失败：回落候选首项。不写 cached、不写 sessionStorage，保证后续调用可重探；
      // 但写入 lastResolved，使同步入口 getApiBase() 与本异步返回值保持一致，
      // 避免生产环境（无 env）同步入口兜底 '' 导致 SSE/工作区请求打到静态站点来源。
      state.lastResolved = fallback;
      return fallback;
    } finally {
      clearTimeout(timeoutId);
      state.pending = null;
    }
  })();

  state.pending = pending;
  return pending;
}

export async function resolveApiBase(): Promise<string> {
  return resolveBase({
    candidates: AGENT_CANDIDATES,
    envUrl: import.meta.env.VITE_API_URL,
    cacheKey: AGENT_CACHE_KEY,
    fallback: AGENT_CANDIDATES[0],
    devFallback: AGENT_LOCAL_FALLBACK,
    state: agentState,
  });
}

export function getApiBase(): string {
  // 解析完成后（成功或回落）以 lastResolved 与 resolveApiBase() 保持一致；
  // 解析前才退回 env / DEV localhost / '' 保守值。
  if (agentState.cached) return agentState.cached;
  if (agentState.lastResolved) return agentState.lastResolved;
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL;
  if (import.meta.env.DEV) return AGENT_LOCAL_FALLBACK;
  return '';
}

export async function resolveControllerApiBase(): Promise<string> {
  return resolveBase({
    candidates: CONTROLLER_CANDIDATES,
    envUrl: import.meta.env.VITE_CONTROLLER_API_URL,
    cacheKey: CONTROLLER_CACHE_KEY,
    fallback: CONTROLLER_CANDIDATES[0],
    devFallback: CONTROLLER_LOCAL_FALLBACK,
    state: controllerState,
  });
}
