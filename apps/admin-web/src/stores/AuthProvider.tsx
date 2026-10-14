import { useState, type ReactNode } from 'react';
import { AuthContext, type AdminUser } from './auth';
import { ADMIN_TOKEN_KEY, ADMIN_USER_KEY } from '@/lib/storage-keys';

function restoreAdmin(): AdminUser | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(ADMIN_USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AdminUser;
  } catch {
    return null;
  }
}

function persist(admin: AdminUser | null) {
  if (typeof localStorage === 'undefined') return;
  if (admin) {
    localStorage.setItem(ADMIN_USER_KEY, JSON.stringify(admin));
  } else {
    localStorage.removeItem(ADMIN_USER_KEY);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdminState] = useState<AdminUser | null>(() => restoreAdmin());
  const [token, setToken] = useState<string | null>(() =>
    typeof localStorage !== 'undefined' ? localStorage.getItem(ADMIN_TOKEN_KEY) : null,
  );

  const login = (newToken: string, newAdmin: AdminUser) => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(ADMIN_TOKEN_KEY, newToken);
    }
    persist(newAdmin);
    setToken(newToken);
    setAdminState(newAdmin);
  };

  const logout = () => {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(ADMIN_TOKEN_KEY);
    }
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
