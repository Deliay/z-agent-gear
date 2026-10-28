import { createContext, useContext } from 'react';

export type TenantType = 'personal' | 'team';

/** 当前用户归属租户（contracts/auth.graphql `Tenant`，一期恒为个人专属租户） */
export interface Tenant {
  id: string;
  name: string;
  type: TenantType;
  memberCount: number;
}

export interface User {
  id: string;
  name: string;
  // 旧登录态（localStorage 遗留）不含 tenant，展示层按可选处理
  tenant?: Tenant | null;
}

export interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (token: string, user: User) => void;
  logout: () => void;
  setUser: (user: User) => void;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
