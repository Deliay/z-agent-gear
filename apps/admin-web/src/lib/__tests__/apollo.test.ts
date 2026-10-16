import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CombinedGraphQLErrors } from '@apollo/client/errors';
import { handleGraphQLError, resetAuthRedirectFlags } from '../apollo';

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: vi.fn(), warning: vi.fn() },
}));

type ErrorInput = ConstructorParameters<typeof CombinedGraphQLErrors>[0];

function gqlError(errors: Array<{ message: string; code?: string }>): CombinedGraphQLErrors {
  return new CombinedGraphQLErrors({
    errors: errors.map(({ message, code }) => ({
      message,
      ...(code ? { extensions: { code } } : {}),
    })),
  } as unknown as ErrorInput);
}

describe('apollo errorLink handler', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    resetAuthRedirectFlags();
  });

  it('ignores non-GraphQL errors', () => {
    const redirect = vi.fn();
    expect(handleGraphQLError(new Error('boom'), redirect)).toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('UNAUTHENTICATED code clears the session and redirects to login', () => {
    localStorage.setItem('admin_token', 't');
    localStorage.setItem('admin_user', '{}');
    const redirect = vi.fn();

    expect(handleGraphQLError(gqlError([{ message: 'oops', code: 'UNAUTHENTICATED' }]), redirect)).toBe('login');

    expect(localStorage.getItem('admin_token')).toBeNull();
    expect(localStorage.getItem('admin_user')).toBeNull();
    expect(mocks.toastError).toHaveBeenCalledWith('登录已过期，请重新登录');
    expect(redirect).toHaveBeenCalledWith('/login');
  });

  it('falls back to the "Not authenticated" message', () => {
    const redirect = vi.fn();
    expect(handleGraphQLError(gqlError([{ message: 'Not authenticated' }]), redirect)).toBe('login');
    expect(redirect).toHaveBeenCalledWith('/login');
  });

  it('MUST_CHANGE_PASSWORD redirects to change-password without clearing the session', () => {
    localStorage.setItem('admin_token', 't');
    const redirect = vi.fn();

    expect(
      handleGraphQLError(gqlError([{ message: 'MUST_CHANGE_PASSWORD', code: 'MUST_CHANGE_PASSWORD' }]), redirect),
    ).toBe('change-password');

    expect(redirect).toHaveBeenCalledWith('/change-password');
    expect(localStorage.getItem('admin_token')).toBe('t');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('de-duplicates repeated auth redirects until flags are reset', () => {
    const redirect = vi.fn();
    const error = () => gqlError([{ message: 'Not authenticated' }]);

    expect(handleGraphQLError(error(), redirect)).toBe('login');
    expect(handleGraphQLError(error(), redirect)).toBeNull();
    expect(redirect).toHaveBeenCalledTimes(1);

    resetAuthRedirectFlags();
    expect(handleGraphQLError(error(), redirect)).toBe('login');
    expect(redirect).toHaveBeenCalledTimes(2);
  });
});
