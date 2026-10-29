import { useState, type ReactNode } from 'react';
import { AuthContext, type User } from './auth';
import { resetWorkspaceStore } from './workspace';

function restoreUser(): User | null {
  const raw = localStorage.getItem('auth_user');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as User & { username?: string };
    // 升级前持久化的登录态只有 username：按迁移后语义（name=原 username）回填展示名
    if (!parsed.name && parsed.username) parsed.name = parsed.username;
    return parsed;
  } catch { return null; }
}

const COOKIE_OPTIONS = 'path=/; max-age=86400; SameSite=Lax';

function setTokenCookie(value: string) {
  document.cookie = `token=${value}; ${COOKIE_OPTIONS}`;
}

function clearTokenCookie() {
  document.cookie = 'token=; path=/; max-age=0';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(() => restoreUser());
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('auth_token'));
  const [loading] = useState(false);

  const login = (newToken: string, newUser: User) => {
    // 切换账号：先清空上一个账号的工作区上下文，随后由 myWorkspaces 同步重建
    resetWorkspaceStore();
    localStorage.setItem('auth_token', newToken);
    localStorage.setItem('auth_user', JSON.stringify(newUser));
    setTokenCookie(newToken);
    setToken(newToken);
    setUserState(newUser);
  };

  const logout = () => {
    resetWorkspaceStore();
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    clearTokenCookie();
    setToken(null);
    setUserState(null);
  };

  const setUser = (newUser: User) => {
    localStorage.setItem('auth_user', JSON.stringify(newUser));
    setUserState(newUser);
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}
