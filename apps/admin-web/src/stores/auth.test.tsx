import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAuth } from './auth';
import { AuthProvider } from './AuthProvider';
import type { ReactNode } from 'react';

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

const admin = { id: '1', username: 'admin', mustChangePassword: true };

describe('useAuth', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should start with no admin and no token', () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.admin).toBeNull();
    expect(result.current.token).toBeNull();
    expect(result.current.mustChangePassword).toBe(false);
  });

  it('should login and store token and admin', () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    act(() => {
      result.current.login('test-token', admin);
    });
    expect(result.current.token).toBe('test-token');
    expect(result.current.admin).toEqual(admin);
    expect(result.current.mustChangePassword).toBe(true);
    expect(localStorage.getItem('admin_token')).toBe('test-token');
    expect(JSON.parse(localStorage.getItem('admin_user')!)).toEqual(admin);
  });

  it('should logout and clear token and admin', () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    act(() => {
      result.current.login('test-token', admin);
    });
    act(() => {
      result.current.logout();
    });
    expect(result.current.token).toBeNull();
    expect(result.current.admin).toBeNull();
    expect(localStorage.getItem('admin_token')).toBeNull();
    expect(localStorage.getItem('admin_user')).toBeNull();
  });

  it('should restore token and admin from localStorage on mount', () => {
    localStorage.setItem('admin_token', 'stored-token');
    localStorage.setItem('admin_user', JSON.stringify(admin));
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.token).toBe('stored-token');
    expect(result.current.admin).toEqual(admin);
  });

  it('should throw when used outside AuthProvider', () => {
    expect(() => renderHook(() => useAuth())).toThrow('useAuth must be used within an AuthProvider');
  });
});
