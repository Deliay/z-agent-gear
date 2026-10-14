// admin-api endpoint 解析（四级优先级，最高优先级在前）：
//   ① localStorage['zag:admin-api-base']（登录页「服务器地址」设置，`/health` 探测通过才保存）
//   ② window.__ADMIN_CONFIG__.apiUrl（nginx 容器启动脚本按 ADMIN_API_URL 注入的 config.js）
//   ③ import.meta.env.VITE_ADMIN_API_URL（构建期默认值，本地由 Aspire 注入）
//   ④ 同源兜底：''（GraphQL 请求走相对路径 /graphql，由部署侧反代）
//
// 用户设置的值在保存时已通过 /health 探测，resolve 时无需再次探测。

export const ADMIN_API_BASE_STORAGE_KEY = 'zag:admin-api-base';
const PROBE_TIMEOUT_MS = 2000;

declare global {
  interface Window {
    __ADMIN_CONFIG__?: { apiUrl?: string };
  }
}

interface AdminRuntimeConfig {
  apiUrl?: string;
}

let cached: string | null = null;
let resolved = false;

function normalize(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

function readStored(): string | null {
  if (typeof localStorage === 'undefined') return null;
  const value = localStorage.getItem(ADMIN_API_BASE_STORAGE_KEY);
  if (!value || !value.trim()) return null;
  return normalize(value);
}

function readWindowConfig(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const config = (window as Window & { __ADMIN_CONFIG__?: AdminRuntimeConfig }).__ADMIN_CONFIG__;
  const url = config?.apiUrl;
  if (!url || !url.trim()) return undefined;
  return normalize(url);
}

function readEnv(): string | undefined {
  const url = import.meta.env.VITE_ADMIN_API_URL as string | undefined;
  if (!url || !url.trim()) return undefined;
  return normalize(url);
}

/** 探测 `<endpoint>/health` 是否可达（2s 超时）。 */
export async function probeAdminApi(endpoint: string): Promise<boolean> {
  const base = normalize(endpoint);
  if (!base) return false;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 解析 admin-api 地址（仅首次执行实际解析，结果缓存在模块状态）。
 * 用户设置的值保存前已探测，因此此处不再探测。
 */
export async function resolveAdminApiBase(): Promise<string> {
  if (resolved) return cached ?? '';

  const stored = readStored();
  if (stored) {
    cached = stored;
    resolved = true;
    return cached;
  }

  const fromWindow = readWindowConfig();
  if (fromWindow) {
    cached = fromWindow;
    resolved = true;
    return cached;
  }

  const fromEnv = readEnv();
  if (fromEnv) {
    cached = fromEnv;
    resolved = true;
    return cached;
  }

  cached = '';
  resolved = true;
  return '';
}

/** 同步读取当前生效的 admin-api 地址（缓存优先，其次 env，最后同源空串）。 */
export function getAdminApiBase(): string {
  if (resolved && cached !== null) return cached;

  const stored = readStored();
  if (stored) return stored;

  const fromWindow = readWindowConfig();
  if (fromWindow) return fromWindow;

  return readEnv() ?? '';
}

/**
 * 设置用户自定义的 admin-api 地址：先探测 `/health`，通过才写入 localStorage 并更新缓存。
 * 探测失败不落盘，返回 false。
 */
export async function setAdminApiBase(endpoint: string): Promise<boolean> {
  const base = normalize(endpoint);
  if (!base) return false;

  const reachable = await probeAdminApi(base);
  if (!reachable) return false;

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(ADMIN_API_BASE_STORAGE_KEY, base);
  }
  cached = base;
  resolved = true;
  return true;
}

/** 清除用户自定义地址，恢复到 window 配置 / env / 同源兜底。 */
export function clearAdminApiBase(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(ADMIN_API_BASE_STORAGE_KEY);
  }
  cached = null;
  resolved = false;
}
