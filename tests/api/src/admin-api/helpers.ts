// 管理后台 API 测试共享 helper。
//
// admin-api 只有一个内置管理员（种子 `admin` / `admin1234567`，首次登录强制改密），
// 因此各 admin 套件需要共享同一管理员登录态。此 helper 把管理员密码「归一化」到
// 固定测试密码 `AdminTestPass123`，使测试可重复执行：
//   - 若仍为默认密码且 mustChangePassword=true：登录后立即改密为 AdminTestPass123；
//   - 若已是 AdminTestPass123：直接登录；
//   - 并发/前次执行导致中间态：带重试收敛。
// 返回的 token 对应 mustChangePassword=false 的管理员，可直接调用业务 mutation。

const ADMIN_API_URL = process.env.ADMIN_API_URL || 'http://localhost:10003/graphql';

export const ADMIN_TEST_PASSWORD = 'AdminTestPass123';
const DEFAULT_ADMIN_PASSWORD = 'admin1234567';

export interface GqlResult<T = Record<string, unknown>> {
  data?: T;
  errors?: Array<{ message: string }>;
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

    // 2) 归一化密码不通，尝试默认密码
    if (!payload) {
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
