import { ApolloClient, InMemoryCache, HttpLink, ApolloLink, from } from '@apollo/client';
import { onError } from '@apollo/client/link/error';
import { CombinedGraphQLErrors } from '@apollo/client/errors';
import { toast } from 'sonner';
import { getCurrentWorkspaceId } from '../stores/workspace';

let isRedirecting = false;

const errorLink = onError(({ error }) => {
  if (isRedirecting) return;

  const isAuthError = CombinedGraphQLErrors.is(error)
    && error.errors.some((e) => e.message === 'Not authenticated');

  if (isAuthError) {
    isRedirecting = true;
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    document.cookie = 'token=; path=/; max-age=0';
    toast.error('Session expired. Please login again.');
    window.location.href = '/login';
  }
});

const authLink = new ApolloLink((operation, forward) => {
  const token = localStorage.getItem('auth_token');
  operation.setContext(({ headers = {} }: { headers?: Record<string, string> }) => ({
    headers: {
      ...headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  }));
  return forward(operation);
});

/**
 * 注入当前租户工作区上下文（多租户二期）。
 * 无选择时不发头 → 服务端回退个人租户全局工作区（与一期行为等价）。
 */
const workspaceLink = new ApolloLink((operation, forward) => {
  const workspaceId = getCurrentWorkspaceId();
  if (!workspaceId) return forward(operation);
  operation.setContext(({ headers = {} }: { headers?: Record<string, string> }) => ({
    headers: {
      ...headers,
      'x-workspace-id': workspaceId,
    },
  }));
  return forward(operation);
});

export function createApolloClient(apiBase: string): ApolloClient {
  const httpLink = new HttpLink({
    uri: `${apiBase}/graphql`,
  });
  return new ApolloClient({
    link: from([errorLink, authLink, workspaceLink, httpLink]),
    cache: new InMemoryCache(),
  });
}
