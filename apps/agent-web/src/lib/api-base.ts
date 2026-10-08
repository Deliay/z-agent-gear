const AGENT_CANDIDATES = ['https://api.zag.fffdan.com', 'https://zag-agent-api.fffdan.com'];
const CONTROLLER_CANDIDATES = ['https://ctrl.zag.fffdan.com', 'https://zag-ctrl-api.fffdan.com'];
const AGENT_CACHE_KEY = 'zag:api-base';
const CONTROLLER_CACHE_KEY = 'zag:controller-api-base';
const PROBE_TIMEOUT_MS = 2000;

interface ResolverState {
  cached: string | null;
}

interface ResolveOptions {
  candidates: readonly string[];
  envUrl: string | undefined;
  cacheKey: string;
  fallback: string;
  state: ResolverState;
}

const agentState: ResolverState = { cached: null };
const controllerState: ResolverState = { cached: null };

function probeCandidate(origin: string, signal: AbortSignal): Promise<string> {
  return fetch(`${origin}/health`, { signal }).then((res) => {
    if (!res.ok) throw new Error(`${res.status}`);
    return origin;
  });
}

async function resolveBase(options: ResolveOptions): Promise<string> {
  const { candidates, envUrl, cacheKey, fallback, state } = options;

  if (state.cached) return state.cached;

  if (envUrl) {
    state.cached = envUrl;
    return envUrl;
  }

  const stored = sessionStorage.getItem(cacheKey);
  if (stored) {
    state.cached = stored;
    return stored;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const winner = await Promise.any(
      candidates.map((origin) => probeCandidate(origin, controller.signal)),
    );
    state.cached = winner;
    controller.abort();
    clearTimeout(timeoutId);
    sessionStorage.setItem(cacheKey, winner);
    return winner;
  } catch {
    clearTimeout(timeoutId);
    state.cached = fallback;
    return fallback;
  }
}

export async function resolveApiBase(): Promise<string> {
  return resolveBase({
    candidates: AGENT_CANDIDATES,
    envUrl: import.meta.env.VITE_API_URL,
    cacheKey: AGENT_CACHE_KEY,
    fallback: AGENT_CANDIDATES[0],
    state: agentState,
  });
}

export function getApiBase(): string {
  if (agentState.cached) return agentState.cached;
  return import.meta.env.VITE_API_URL || '';
}

export async function resolveControllerApiBase(): Promise<string> {
  return resolveBase({
    candidates: CONTROLLER_CANDIDATES,
    envUrl: import.meta.env.VITE_CONTROLLER_API_URL,
    cacheKey: CONTROLLER_CACHE_KEY,
    fallback: CONTROLLER_CANDIDATES[0],
    state: controllerState,
  });
}
