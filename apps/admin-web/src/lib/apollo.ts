import { ApolloClient, InMemoryCache, HttpLink, ApolloLink, from } from '@apollo/client';
import { onError } from '@apollo/client/link/error';
import { CombinedGraphQLErrors } from '@apollo/client/errors';
import { toast } from 'sonner';
import { ADMIN_TOKEN_KEY, ADMIN_USER_KEY } from './storage-keys';
import { getBasePath } from './base-path';

let isAuthRedirecting = false;
let isPasswordRedirecting = false;

type AuthRedirect = 'login' | 'change-password';

function defaultRedirect(path: string): void {
  window.location.href = `${getBasePath()}${path}`;
}

function clearAuthStorage(): void {
  try {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    localStorage.removeItem(ADMIN_USER_KEY);
  } catch {
    // localStorage 不可用（隐私模式/被禁用）时忽略，跳转登录页即可
  }
}

/** 重置跳转去重标志（仅测试使用，避免跨用例相互影响）。 */
export function resetAuthRedirectFlags(): void {
  isAuthRedirecting = false;
  isPasswordRedirecting = false;
}

/**
 * 处理 GraphQL 错误中的鉴权跳转（`lib/apollo.ts` errorLink 核心逻辑，独立导出便于测试）：
 * - `UNAUTHENTICATED` / `Not authenticated` → 清除本地登录态并跳转登录页
 * - `MUST_CHANGE_PASSWORD` → 跳转强制改密页
 *
 * 返回触发的跳转类型（未触发或已去重则返回 null）。
 */
export function handleGraphQLError(
  error: unknown,
  redirect: (path: string) => void = defaultRedirect,
): AuthRedirect | null {
  if (!CombinedGraphQLErrors.is(error)) return null;

  const messages = error.errors.map((e) => e.message);
  // 优先按 extensions.code 匹配（后端已写入），message 作为兼容兜底
  const codes = error.errors.map((e) => e.extensions?.code as string | undefined);

  if (messages.includes('Not authenticated') || codes.includes('UNAUTHENTICATED')) {
    if (isAuthRedirecting) return null;
    isAuthRedirecting = true;
    clearAuthStorage();
    toast.error('登录已过期，请重新登录');
    redirect('/login');
    return 'login';
  }

  if (messages.includes('MUST_CHANGE_PASSWORD') || codes.includes('MUST_CHANGE_PASSWORD')) {
    if (isPasswordRedirecting) return null;
    isPasswordRedirecting = true;
    redirect('/change-password');
    return 'change-password';
  }

  return null;
}

const errorLink = onError(({ error }) => {
  handleGraphQLError(error);
});

const authLink = new ApolloLink((operation, forward) => {
  let token: string | null = null;
  try {
    token = typeof localStorage !== 'undefined' ? localStorage.getItem(ADMIN_TOKEN_KEY) : null;
  } catch {
    token = null;
  }
  operation.setContext(({ headers = {} }: { headers?: Record<string, string> }) => ({
    headers: {
      ...headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  }));
  return forward(operation);
});

export function createApolloClient(apiBase: string): ApolloClient {
  const httpLink = new HttpLink({
    uri: `${apiBase}/graphql`,
  });
  return new ApolloClient({
    link: from([errorLink, authLink, httpLink]),
    cache: new InMemoryCache(),
  });
}
