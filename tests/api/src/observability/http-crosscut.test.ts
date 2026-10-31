/**
 * T-OBS19 API 横切（需 live 服务；遵循 tests/api/AGENTS.md 的 env 约定）。
 *
 * 断言口径（plan §5 T-OBS19 / contracts/observability.md §5.2）：
 * 1. 四服务 `/health`（agent-api / admin-api / controller-api / cloud-controller）响应头带
 *    `x-request-id`；GraphQL endpoint（agent-api / admin-api，controller-api 与 cloud-controller
 *    无 GraphQL）同样带；
 * 2. 入站合法 `x-request-id`（如 `test-req-123456`）被沿用（响应回显同值）；
 *    非法值（如 `bad id!`）被替换（回显 ≠ 入站值且为 UUID 形态）；
 * 3. 错误响应（错误 GraphQL query / 未授权）body join 后不含明文凭据
 *    （以 INTERNAL_API_TOKEN / ADMIN_INITIAL_PASSWORD 的实际值与哨兵值断言）。
 *
 * 连通性前置：模块加载时探测各服务 `/health`；不可达时对应 `it.skipIf` 跳过并输出启动指引
 * （Aspire 起服务后填入 API_URL / ADMIN_API_URL / CONTROLLER_API_URL / CLOUD_CONTROLLER_URL），
 * 不假装通过。
 */
import { describe, it, expect } from 'vitest';

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const ADMIN_API_URL = process.env.ADMIN_API_URL || 'http://localhost:10003/graphql';
const CONTROLLER_API_URL = (process.env.CONTROLLER_API_URL || 'http://localhost:35273')
  .replace(/\/+$/, '')
  .replace(/\/graphql$/, '');
const CLOUD_CONTROLLER_URL = (process.env.CLOUD_CONTROLLER_URL || 'http://localhost:10004').replace(/\/+$/, '');

const AGENT_BASE = API_URL.replace(/\/graphql\/?$/, '');
const ADMIN_BASE = ADMIN_API_URL.replace(/\/graphql\/?$/, '');

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 入站合法值样本（契约：`/^[A-Za-z0-9._:-]{8,128}$/`）。 */
const VALID_REQUEST_ID = 'test-req-123456';
/** 入站非法值样本（含空格与 `!`）。 */
const INVALID_REQUEST_ID = 'bad id!';

/** 哨兵凭据：错误响应回显它们即失败；另叠加真实 env 值（如提供）。 */
const FAKE_TOKEN = 'sk-obs-secret-0123456789abcdef';
const FAKE_PASSWORD = 'ObsSecretPass!23456';

const SECRETS = [FAKE_TOKEN, FAKE_PASSWORD];
for (const value of [process.env.INTERNAL_API_TOKEN, process.env.ADMIN_INITIAL_PASSWORD]) {
  if (value && value.length >= 6) SECRETS.push(value);
}

async function ping(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const up = {
  agent: await ping(AGENT_BASE),
  admin: await ping(ADMIN_BASE),
  controller: await ping(CONTROLLER_API_URL),
  cloud: await ping(CLOUD_CONTROLLER_URL),
};

if (!up.agent || !up.admin || !up.controller || !up.cloud) {
  const down = Object.entries(up)
    .filter(([, ok]) => !ok)
    .map(([k]) => k)
    .join(', ');
  console.warn(
    `[T-OBS19] 以下服务不可达，对应用例将 skip：${down}。\n` +
      '启动指引：在仓库根目录 `aspire start && aspire wait agent-api admin-api controller-api cloud-controller`，' +
      '再以 `API_URL=... ADMIN_API_URL=... CONTROLLER_API_URL=... CLOUD_CONTROLLER_URL=... npx vitest run src/observability` 运行（见 tests/api/AGENTS.md）。',
  );
}

interface ServiceCase {
  key: string;
  base: string;
  reachable: boolean;
  /** 是否提供 GraphQL endpoint（controller-api / cloud-controller 无）。 */
  graphql?: string;
}

const SERVICES: ServiceCase[] = [
  { key: 'agent-api', base: AGENT_BASE, reachable: up.agent, graphql: API_URL },
  { key: 'admin-api', base: ADMIN_BASE, reachable: up.admin, graphql: ADMIN_API_URL },
  { key: 'controller-api', base: CONTROLLER_API_URL, reachable: up.controller },
  { key: 'cloud-controller', base: CLOUD_CONTROLLER_URL, reachable: up.cloud },
];

async function getHealth(svc: ServiceCase, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${svc.base}/health`, { headers: extraHeaders, signal: AbortSignal.timeout(5000) });
}

async function postGraphql(
  url: string,
  query: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(5000),
  });
}

describe('T-OBS19 响应头带 x-request-id', () => {
  for (const svc of SERVICES) {
    it.skipIf(!svc.reachable)(`${svc.key} /health 响应头带 x-request-id`, async () => {
      const res = await getHealth(svc);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-request-id')).toBeTruthy();
    });
  }

  for (const svc of SERVICES.filter((s) => s.graphql)) {
    it.skipIf(!svc.reachable)(`${svc.key} GraphQL endpoint 响应头带 x-request-id`, async () => {
      const res = await postGraphql(svc.graphql!, '{ __typename }');
      expect(res.headers.get('x-request-id')).toBeTruthy();
    });
  }
});

describe('T-OBS19 入站 x-request-id 归一化', () => {
  for (const svc of SERVICES) {
    it.skipIf(!svc.reachable)(`${svc.key}: 合法入站值沿用`, async () => {
      const res = await getHealth(svc, { 'x-request-id': VALID_REQUEST_ID });
      expect(res.headers.get('x-request-id')).toBe(VALID_REQUEST_ID);
    });

    it.skipIf(!svc.reachable)(`${svc.key}: 非法入站值被替换为 UUID`, async () => {
      const res = await getHealth(svc, { 'x-request-id': INVALID_REQUEST_ID });
      const echoed = res.headers.get('x-request-id');
      expect(echoed).toBeTruthy();
      expect(echoed).not.toBe(INVALID_REQUEST_ID);
      expect(echoed, `非法入站值应替换为 UUID v4，实际：${echoed}`).toMatch(UUID_V4_RE);
    });
  }

  for (const svc of SERVICES.filter((s) => s.graphql)) {
    it.skipIf(!svc.reachable)(`${svc.key} GraphQL: 合法沿用 / 非法替换`, async () => {
      const kept = await postGraphql(svc.graphql!, '{ __typename }', { 'x-request-id': VALID_REQUEST_ID });
      expect(kept.headers.get('x-request-id')).toBe(VALID_REQUEST_ID);

      const replaced = await postGraphql(svc.graphql!, '{ __typename }', { 'x-request-id': INVALID_REQUEST_ID });
      const echoed = replaced.headers.get('x-request-id');
      expect(echoed).not.toBe(INVALID_REQUEST_ID);
      expect(echoed).toMatch(UUID_V4_RE);
    });
  }
});

describe('T-OBS19 错误响应不回显明文凭据', () => {
  function expectNoSecrets(body: string, label: string): void {
    for (const secret of SECRETS) {
      expect(body, `${label} 响应体回显了明文凭据（${secret.slice(0, 4)}…）`).not.toContain(secret);
    }
    // 通用兜底：响应体不含 password/token 字段明文取值形态
    expect(body, `${label} 响应体疑似回显 password 明文`).not.toMatch(/"password"\s*:\s*"(?!\[REDACTED])/);
    expect(body, `${label} 响应体疑似回显 token 明文`).not.toMatch(/"token"\s*:\s*"(?!\[REDACTED])/);
  }

  it.skipIf(!up.agent)('agent-api: 错误 GraphQL query + 伪 Bearer 不回显凭据', async () => {
    const res = await postGraphql(API_URL, 'query { thisFieldDoesNotExist }', {
      Authorization: `Bearer ${FAKE_TOKEN}`,
    });
    const body = await res.text();
    expect(body).toBeTruthy();
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expectNoSecrets(body, 'agent-api 错误 query');
  });

  it.skipIf(!up.agent)('agent-api: login 错误口令不回显', async () => {
    const res = await postGraphql(
      API_URL,
      `mutation { login(username: "obs-probe-${Date.now()}", password: "${FAKE_PASSWORD}") { token } }`,
    );
    const body = await res.text();
    expectNoSecrets(body, 'agent-api login 失败');
  });

  it.skipIf(!up.admin)('admin-api: 错误 GraphQL query + 伪 Bearer 不回显凭据', async () => {
    const res = await postGraphql(ADMIN_API_URL, 'query { thisFieldDoesNotExist }', {
      Authorization: `Bearer ${FAKE_TOKEN}`,
    });
    const body = await res.text();
    expect(body).toBeTruthy();
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expectNoSecrets(body, 'admin-api 错误 query');
  });

  it.skipIf(!up.admin)('admin-api: adminLogin 错误口令不回显', async () => {
    const res = await postGraphql(
      ADMIN_API_URL,
      `mutation { adminLogin(username: "admin", password: "${FAKE_PASSWORD}") { token } }`,
    );
    const body = await res.text();
    expectNoSecrets(body, 'admin-api adminLogin 失败');
  });

  it.skipIf(!up.agent || !process.env.INTERNAL_API_TOKEN)(
    'agent-api: 真实 INTERNAL_API_TOKEN 作 Bearer 也不回显',
    async () => {
      const res = await postGraphql(API_URL, 'query { thisFieldDoesNotExist }', {
        Authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}`,
      });
      const body = await res.text();
      expectNoSecrets(body, 'agent-api 带真实 token 的错误 query');
    },
  );

  it.skipIf(!up.cloud)('cloud-controller: 未授权内部 API 错误响应不回显凭据', async () => {
    const res = await fetch(`${CLOUD_CONTROLLER_URL}/internal/containers`, {
      headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.text();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expectNoSecrets(body, 'cloud-controller 未授权');
  });
});
