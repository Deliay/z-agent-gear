import { useState, type ReactNode } from 'react';
import { AuthContext, type User } from './auth';

function restoreUser(): User | null {
  const raw = localStorage.getItem('auth_user');
  if (!raw) return null;
  try { return JSON.parse(raw) as User; } catch { return null; }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(() => restoreUser());
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('auth_token'));
  const [loading] = useState(false);

  const login = (newToken: string, newUser: User) => {
    localStorage.setItem('auth_token', newToken);
    localStorage.setItem('auth_user', JSON.stringify(newUser));
    setToken(newToken);
    setUserState(newUser);
  };

  const logout = () => {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
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
