import { useState, type ReactNode } from 'react';
import { AuthContext, type AdminUser } from './auth';
import { ADMIN_TOKEN_KEY, ADMIN_USER_KEY } from '@/lib/storage-keys';

function isValidAdmin(value: unknown): value is AdminUser {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.username === 'string' &&
    typeof candidate.mustChangePassword === 'boolean'
  );
}

function safeGet(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // localStorage 受限时忽略持久化失败，保持内存态可用
  }
}

function safeRemove(key: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  } catch {
    // 忽略
  }
}

function restoreAdmin(): AdminUser | null {
  const raw = safeGet(ADMIN_USER_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidAdmin(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function restoreToken(): string | null {
  const token = safeGet(ADMIN_TOKEN_KEY);
  return token && token.trim() ? token : null;
}

function persist(admin: AdminUser | null) {
  if (admin) {
    safeSet(ADMIN_USER_KEY, JSON.stringify(admin));
  } else {
    safeRemove(ADMIN_USER_KEY);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdminState] = useState<AdminUser | null>(() => restoreAdmin());
  const [token, setToken] = useState<string | null>(() => restoreToken());

  const login = (newToken: string, newAdmin: AdminUser) => {
    safeSet(ADMIN_TOKEN_KEY, newToken);
    persist(newAdmin);
    setToken(newToken);
    setAdminState(newAdmin);
  };

  const logout = () => {
    safeRemove(ADMIN_TOKEN_KEY);
    persist(null);
    setToken(null);
    setAdminState(null);
  };

  const setAdmin = (newAdmin: AdminUser) => {
    persist(newAdmin);
    setAdminState(newAdmin);
  };

  const mustChangePassword = admin?.mustChangePassword ?? false;

  return (
    <AuthContext.Provider value={{ admin, token, mustChangePassword, login, logout, setAdmin }}>
      {children}
    </AuthContext.Provider>
  );
}
