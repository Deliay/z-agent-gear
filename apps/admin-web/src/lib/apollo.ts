import { ApolloClient, InMemoryCache, HttpLink, ApolloLink, from } from '@apollo/client';
import { onError } from '@apollo/client/link/error';
import { CombinedGraphQLErrors } from '@apollo/client/errors';
import { toast } from 'sonner';
import { ADMIN_TOKEN_KEY, ADMIN_USER_KEY } from './storage-keys';

let isAuthRedirecting = false;
let isPasswordRedirecting = false;

const errorLink = onError(({ error }) => {
  if (!CombinedGraphQLErrors.is(error)) return;
  const messages = error.errors.map((e) => e.message);

  if (messages.includes('Not authenticated')) {
    if (isAuthRedirecting) return;
    isAuthRedirecting = true;
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    localStorage.removeItem(ADMIN_USER_KEY);
    toast.error('登录已过期，请重新登录');
    window.location.href = '/login';
    return;
  }

  if (messages.includes('MUST_CHANGE_PASSWORD')) {
    if (isPasswordRedirecting) return;
    isPasswordRedirecting = true;
    window.location.href = '/change-password';
  }
});

const authLink = new ApolloLink((operation, forward) => {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem(ADMIN_TOKEN_KEY) : null;
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
