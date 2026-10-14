import { createContext, useContext } from 'react';

export interface AdminUser {
  id: string;
  username: string;
  mustChangePassword: boolean;
}

export interface AuthContextType {
  admin: AdminUser | null;
  token: string | null;
  mustChangePassword: boolean;
  login: (token: string, admin: AdminUser) => void;
  logout: () => void;
  setAdmin: (admin: AdminUser) => void;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
