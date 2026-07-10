import { ApolloClient, InMemoryCache, HttpLink, ApolloLink, from } from '@apollo/client';
import { onError } from '@apollo/client/link/error';
import { CombinedGraphQLErrors } from '@apollo/client/errors';
import { toast } from 'sonner';

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

const httpLink = new HttpLink({
  uri: `${import.meta.env.VITE_API_URL || ''}/graphql`,
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

export const client = new ApolloClient({
  link: from([errorLink, authLink, httpLink]),
  cache: new InMemoryCache(),
});
