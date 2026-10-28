/**
 * 前台测试用户引导（多租户一期 F4）。
 *
 * 前台注册已硬关闭（`contracts/auth.graphql` 无 `signup` mutation）：测试用户统一经
 * agent-api 内部开户端点 `POST /internal/users`（Bearer `INTERNAL_API_TOKEN`）创建
 * 「登录账户 + 用户 + 同名个人专属租户 + 零余额租户计费账户」，再用 GraphQL `login`
 * 取 token。
 *
 * 契约口径（`contracts/admin-tenant.graphql` / 计划 Phase 3、Phase 5）：
 * - 开户成功 201（幂等重放 200）→ `{ user: {id,name,createdAt}, account: {id,username}, tenant: {id,name,type} }`；
 * - 用户名冲突 409 `USERNAME_TAKEN`；参数非法 400 `INVALID_BODY`；未鉴权 401。
 * - personal 期 `tenant.id === user.id`（与 userId 同值），前端 token 载荷仍为 userId。
 */

const GRAPHQL_URL = process.env.API_URL || 'http://localhost:10001/graphql';
/** agent-api 内部端点 origin：`http://host:port/graphql` → `http://host:port`。 */
const AGENT_API_BASE = GRAPHQL_URL.replace(/\/graphql\/?$/, '');

export const DEFAULT_FRONT_USER_PASSWORD = 'testpass123';

export interface FrontUser {
  username: string;
  password: string;
  token: string;
  userId: string;
  /** 展示名（迁移后 = 原用户名）。 */
  name: string;
  /** 归属租户 id（personal 期 == userId）。 */
  tenantId: string;
}

export interface InternalUserCreateResponse {
  user: { id: string; name: string; createdAt?: string };
  account: { id: string; username: string };
  tenant: { id: string; name: string; type: string };
}

export interface FrontUserLoginPayload {
  token: string;
  user: {
    id: string;
    name: string;
    tenant: { id: string; name: string; type: string; memberCount: number };
  };
}

/** agent-api 内部端点 origin（`API_URL` 去掉 `/graphql`）。 */
export function agentApiBaseUrl(): string {
  return AGENT_API_BASE;
}

/** 默认用户名：唯一且满足 2-20 字符规则（时间戳 + 随机 + 进程内自增）。 */
let usernameSeq = 0;
export function uniqueFrontUsername(prefix = 'u'): string {
  usernameSeq += 1;
  const stamp = Date.now().toString(36).slice(-8);
  const rand = Math.random().toString(36).slice(2, 5);
  return `${prefix}${stamp}${rand}${usernameSeq.toString(36)}`.slice(0, 20);
}

/**
 * 直接请求内部开户端点，返回原始 Response（便于断言 201/200/409/400/401）。
 * `token` 缺省取 `INTERNAL_API_TOKEN`；显式传空串可用于断言 401。
 */
export async function internalUsersRequest(
  body: { username?: string; password?: string } | unknown,
  token: string | undefined = process.env.INTERNAL_API_TOKEN,
): Promise<Response> {
  if (!token) {
    throw new Error(
      'createFrontUser requires INTERNAL_API_TOKEN (agent-api 内部开户端点 Bearer token)；' +
        '请经 Aspire 注入后重跑（aspire describe agent-api）。',
    );
  }
  return fetch(`${AGENT_API_BASE}/internal/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

const LOGIN = `
  mutation Login($username: String!, $password: String!) {
    login(username: $username, password: $password) {
      token
      user { id name tenant { id name type memberCount } }
    }
  }
`;

/** GraphQL `login`：返回 `{ token, user { id, name, tenant } }`。 */
export async function loginFrontUser(
  username: string,
  password: string,
): Promise<FrontUserLoginPayload> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: LOGIN, variables: { username, password } }),
  });
  const body = (await res.json()) as {
    data?: { login?: FrontUserLoginPayload };
    errors?: Array<{ message: string }>;
  };
  if (!body.data?.login) {
    const detail = body.errors?.map((e) => e.message).join('; ') ?? 'no login payload';
    throw new Error(`login failed for "${username}": ${detail}`);
  }
  return body.data.login;
}

/**
 * 开户（`POST /internal/users`）+ 登录，返回测试所需的用户身份四件套。
 *
 * 用户名默认唯一（时间戳 + 随机）；重复用户名会以 409 显式失败而非静默复用。
 */
export async function createFrontUser(
  username: string = uniqueFrontUsername(),
  password: string = DEFAULT_FRONT_USER_PASSWORD,
): Promise<FrontUser> {
  const res = await internalUsersRequest({ username, password });
  if (res.status === 409) {
    throw new Error(`createFrontUser("${username}") failed: 409 USERNAME_TAKEN`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`createFrontUser("${username}") failed: ${res.status} ${text}`.trim());
  }
  const created = (await res.json()) as InternalUserCreateResponse;
  if (!created?.user?.id || !created?.tenant?.id) {
    throw new Error(
      `createFrontUser("${username}") returned unexpected payload: ${JSON.stringify(created)}`,
    );
  }

  const login = await loginFrontUser(username, password);
  const tenantId = login.user?.tenant?.id ?? created.tenant.id;
  if (!tenantId) {
    throw new Error(`createFrontUser("${username}") login payload missing tenant`);
  }

  return {
    username,
    password,
    token: login.token,
    userId: login.user?.id ?? created.user.id,
    name: login.user?.name ?? created.user.name,
    tenantId,
  };
}
