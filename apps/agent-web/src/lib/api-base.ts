const API_CANDIDATES = ['https://api.zag.fffdan.com', 'https://zag-agent-api.fffdan.com'];
const CACHE_KEY = 'zag:api-base';
const PROBE_TIMEOUT_MS = 2000;

let cachedResult: string | null = null;

function probeCandidate(origin: string, signal: AbortSignal): Promise<string> {
  return fetch(`${origin}/health`, { signal })
    .then((res) => {
      if (!res.ok) throw new Error(`${res.status}`);
      return origin;
    });
}

export async function resolveApiBase(): Promise<string> {
  if (cachedResult) return cachedResult;

  const envUrl = import.meta.env.VITE_API_URL;
  if (envUrl) {
    cachedResult = envUrl;
    return envUrl;
  }

  const stored = sessionStorage.getItem(CACHE_KEY);
  if (stored) {
    cachedResult = stored;
    return stored;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const winner = await Promise.any(
      API_CANDIDATES.map((origin) => probeCandidate(origin, controller.signal)),
    );
    cachedResult = winner;
    controller.abort();
    clearTimeout(timeoutId);
    sessionStorage.setItem(CACHE_KEY, cachedResult);
    return cachedResult;
  } catch {
    clearTimeout(timeoutId);
    cachedResult = API_CANDIDATES[0];
    return cachedResult;
  }
}

export function getApiBase(): string {
  if (cachedResult) return cachedResult;
  return import.meta.env.VITE_API_URL || '';
}
