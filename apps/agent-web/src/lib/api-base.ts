const API_CANDIDATES = ['https://api.zag.fffdan.com', 'https://zag-agent-api.fffdan.com'];
const CACHE_KEY = 'zag:api-base';
const PROBE_TIMEOUT_MS = 2000;

let cachedResult: string | null = null;

function probeCandidate(origin: string, controller: AbortController): Promise<string | null> {
  return fetch(`${origin}/health`, { signal: controller.signal })
    .then((res) => (res.ok ? origin : null))
    .catch(() => null);
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
    return cachedResult;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const results = await Promise.allSettled(
      API_CANDIDATES.map((origin) => probeCandidate(origin, controller)),
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        cachedResult = r.value;
        controller.abort();
        clearTimeout(timeoutId);
        sessionStorage.setItem(CACHE_KEY, cachedResult);
        return cachedResult;
      }
    }

    cachedResult = API_CANDIDATES[0];
    clearTimeout(timeoutId);
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
