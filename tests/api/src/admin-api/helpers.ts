// 管理后台 API 测试共享 helper。
//
// admin-api 只有一个内置管理员（种子 `admin` / 部署注入的 `ADMIN_INITIAL_PASSWORD`；
// 未注入时服务会生成随机初始密码，此时需通过 `ADMIN_INITIAL_PASSWORD` 环境变量告知测试），
// 首次登录强制改密。因此各 admin 套件需要共享同一管理员登录态。此 helper 把管理员密码
// 「归一化」到固定测试密码 `AdminTestPass123`，使测试可重复执行：
//   - 若仍为初始密码且 mustChangePassword=true：登录后立即改密为 AdminTestPass123；
//   - 若已是 AdminTestPass123：直接登录；
//   - 并发/前次执行导致中间态：带重试收敛。
// 返回的 token 对应 mustChangePassword=false 的管理员，可直接调用业务 mutation。

import mongoose from 'mongoose';

const ADMIN_API_URL = process.env.ADMIN_API_URL || 'http://localhost:10003/graphql';
const AGENT_API_URL = process.env.API_URL || 'http://localhost:10001/graphql';

export const ADMIN_TEST_PASSWORD = 'AdminTestPass123';
// 管理员初始密码不再硬编码（问题 4 / 问题 47）：只能来自部署注入的 ADMIN_INITIAL_PASSWORD。
// 不再回落任何公开默认口令（`admin1234567` / `dev-admin-init-password` 均已被 admin-api 拒绝）。
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_INITIAL_PASSWORD || '';

export interface GqlResult<T = Record<string, unknown>> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

export function adminGqlRequest(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(ADMIN_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });
}

export async function adminGql<T = Record<string, unknown>>(
  query: string,
  variables?: Record<string, unknown>,
  token?: string,
): Promise<GqlResult<T>> {
  const res = await adminGqlRequest(query, variables, token);
  return (await res.json()) as GqlResult<T>;
}

const LOGIN = `
  mutation AdminLogin($username: String!, $password: String!) {
    adminLogin(username: $username, password: $password) {
      token
      admin { id username mustChangePassword }
    }
  }
`;

const CHANGE_PASSWORD = `
  mutation ChangeAdminPassword($oldPassword: String!, $newPassword: String!) {
    changeAdminPassword(oldPassword: $oldPassword, newPassword: $newPassword) {
      token
      admin { id username mustChangePassword }
    }
  }
`;

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tryLogin(password: string) {
  const body = await adminGql<{ adminLogin: { token: string; admin: { mustChangePassword: boolean } } }>(
    LOGIN,
    { username: 'admin', password },
  );
  return body.data?.adminLogin ?? null;
}

/**
 * 保障存在一个 mustChangePassword=false 的管理员并返回其 token。
 * 可重复调用（多次执行测试时密码已被归一化也能通过）。
 */
export async function ensureAdminLogin(): Promise<string> {
  let lastError = 'unknown';

  for (let attempt = 0; attempt < 6; attempt += 1) {
    // 1) 先按归一化密码登录
    let payload = await tryLogin(ADMIN_TEST_PASSWORD);

    // 2) 归一化密码不通，尝试部署注入的初始密码（未注入时跳过，避免无意义失败计入限速）
    if (!payload && DEFAULT_ADMIN_PASSWORD) {
      payload = await tryLogin(DEFAULT_ADMIN_PASSWORD);
    }

    if (!payload) {
      lastError = 'adminLogin failed with both default and normalized password';
      await sleep(500);
      continue;
    }

    // 3) 需要强制改密时归一化到固定测试密码
    if (payload.admin.mustChangePassword) {
      const changed = await adminGql<{ changeAdminPassword: { token: string; admin: { mustChangePassword: boolean } } }>(
        CHANGE_PASSWORD,
        { oldPassword: DEFAULT_ADMIN_PASSWORD, newPassword: ADMIN_TEST_PASSWORD },
        payload.token,
      );
      if (changed.data?.changeAdminPassword) {
        return changed.data.changeAdminPassword.token;
      }
      if (changed.errors) lastError = changed.errors[0].message;
      await sleep(500);
      continue;
    }

    return payload.token;
  }

  throw new Error(`ensureAdminLogin failed: ${lastError}`);
}

/**
 * 真实用户侧 JWT（agent-api 签发，JWT_SECRET）——用于验证 admin/user token 互不认（T-A6）。
 */
export async function signupUserToken(): Promise<string> {
  const username = `as${Date.now().toString(36).slice(-8)}${Math.random().toString(36).slice(2, 5)}`;
  const res = await fetch(AGENT_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'mutation($u:String!,$p:String!){signup(username:$u,password:$p){token}}',
      variables: { u: username, p: 'testpass123' },
    }),
  });
  const body = (await res.json()) as { data?: { signup?: { token?: string } } };
  const token = body.data?.signup?.token;
  if (!token) throw new Error('failed to signup a user for token isolation test');
  return token;
}

/**
 * 直接修改 admin_users.mustChangePassword（用于 T-A7 强制改密守卫集成测试）。
 * 需要 MONGODB_URI（aspire 注入的共享 Mongo）；缺失时返回 false，调用方跳过。
 */
export async function setAdminMustChangePassword(value: boolean): Promise<boolean> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return false;

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri);
  }
  const db = mongoose.connection.db;
  if (!db) return false;
  await db.collection('admin_users').updateOne({ username: 'admin' }, { $set: { mustChangePassword: value } });
  return true;
}

