import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAuth } from './auth';
import { AuthProvider } from './AuthProvider';
import type { ReactNode } from 'react';

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

describe('useAuth', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should start with no user and no token', () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.user).toBeNull();
    expect(result.current.token).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('should login and store token and user', () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    act(() => {
      result.current.login('test-token', { id: '1', username: 'testuser' });
    });
    expect(result.current.token).toBe('test-token');
    expect(result.current.user).toEqual({ id: '1', username: 'testuser' });
    expect(localStorage.getItem('auth_token')).toBe('test-token');
    expect(JSON.parse(localStorage.getItem('auth_user')!)).toEqual({ id: '1', username: 'testuser' });
  });

  it('should logout and clear token and user', () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    act(() => {
      result.current.login('test-token', { id: '1', username: 'testuser' });
    });
    expect(result.current.token).toBe('test-token');
    act(() => {
      result.current.logout();
    });
    expect(result.current.token).toBeNull();
    expect(result.current.user).toBeNull();
    expect(localStorage.getItem('auth_token')).toBeNull();
    expect(localStorage.getItem('auth_user')).toBeNull();
  });

  it('should restore token and user from localStorage on mount', () => {
    localStorage.setItem('auth_token', 'stored-token');
    localStorage.setItem('auth_user', JSON.stringify({ id: '1', username: 'stored-user' }));
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.token).toBe('stored-token');
    expect(result.current.user).toEqual({ id: '1', username: 'stored-user' });
  });

  it('should throw when used outside AuthProvider', () => {
    expect(() => renderHook(() => useAuth())).toThrow('useAuth must be used within an AuthProvider');
  });
});
