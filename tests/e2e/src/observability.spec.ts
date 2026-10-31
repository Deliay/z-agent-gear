/**
 * T-OBS20 可观测性 E2E 冒烟（plan §5 T-OBS20）。
 *
 * 1. 四服务首屏日志每行可 `JSON.parse` 且含 `level/time/service/msg`（pino 单行 JSON 契约）；
 * 2. 一次跨服务 GraphQL 请求后，同一 `trace_id` 同时出现在 agent-api 与 admin-api 日志
 *    （W3C traceparent HTTP 通道传播 + mixin 注入 `trace_id`）。
 *
 * 日志获取（按优先级，任一可用即跑，全部不可得时 **明确 skip 并输出指引**，不假装通过）：
 * - 环境变量 `AGENT_API_LOG_FILE` / `ADMIN_API_LOG_FILE` / `CONTROLLER_API_LOG_FILE` /
 *   `CLOUD_CONTROLLER_LOG_FILE` 指向日志文件（或 `OBSERVABILITY_LOG_DIR` 目录下 `<service>.log`）；
 * - `docker compose logs <service>`（可用 `OBS_LOGS_DISABLE_DOCKER=1` 关闭该回落）。
 *
 * trace 用例需要 OTEL SDK 生效（服务以 `OTEL_EXPORTER_OTLP_ENDPOINT` 配置启动，如 Aspire
 * collector / compose otel-endpoint），否则日志无 `trace_id` 字段（契约 §7 采样与日志解耦）。
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_TEST_PASSWORD, DEFAULT_ADMIN_PASSWORD, forceAdminPassword } from './helpers.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const API_URL = process.env.API_URL || 'http://localhost:10001/graphql';
const ADMIN_API_URL = process.env.ADMIN_API_URL || 'http://localhost:10003/graphql';
const AGENT_BASE = API_URL.replace(/\/graphql\/?$/, '');
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || '';

const SERVICES = [
  { key: 'agent-api', env: 'AGENT_API_LOG_FILE' },
  { key: 'admin-api', env: 'ADMIN_API_LOG_FILE' },
  { key: 'controller-api', env: 'CONTROLLER_API_LOG_FILE' },
  { key: 'cloud-controller', env: 'CLOUD_CONTROLLER_LOG_FILE' },
] as const;

const LOG_GUIDE =
  '未获取到服务日志。指引：① 以 `AGENT_API_LOG_FILE=… ADMIN_API_LOG_FILE=… CONTROLLER_API_LOG_FILE=… ' +
  'CLOUD_CONTROLLER_LOG_FILE=…`（或 `OBSERVABILITY_LOG_DIR=<目录>`，每服务一个 `<service>.log`）指向服务日志文件；' +
  '② 或在 docker compose 项目目录（如 aspire/manifest）下使 `docker compose logs <service>` 可用后重跑。';

function readEnvLogs(svc: (typeof SERVICES)[number]): string[] | undefined {
  const file = process.env[svc.env];
  if (file && existsSync(file)) return readFileSync(file, 'utf8').split('\n');
  const dir = process.env.OBSERVABILITY_LOG_DIR;
  if (dir) {
    const p = join(dir, `${svc.key}.log`);
    if (existsSync(p)) return readFileSync(p, 'utf8').split('\n');
  }
  return undefined;
}

function readComposeLogs(svc: (typeof SERVICES)[number]): string[] | undefined {
  if (process.env.OBS_LOGS_DISABLE_DOCKER === '1') return undefined;
  const composeFile = process.env.COMPOSE_FILE
    ? resolve(process.env.COMPOSE_FILE)
    : join(repoRoot, 'aspire', 'manifest', 'docker-compose.yaml');
  const cwd = existsSync(composeFile) ? dirname(composeFile) : repoRoot;
  try {
    const out = execFileSync('docker', ['compose', 'logs', '--no-color', '--no-log-prefix', svc.key], {
      cwd,
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n');
  } catch {
    return undefined;
  }
}

function logLines(svc: (typeof SERVICES)[number]): string[] | undefined {
  return readEnvLogs(svc) ?? readComposeLogs(svc);
}

function traceIds(lines: string[]): Set<string> {
  const ids = new Set<string>();
  for (const line of lines) {
    const m = /"trace_id"\s*:\s*"([0-9a-f]{32})"/.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

const FRONT_USER_PASSWORD = 'testpass123';

/** 进程内 fetch 的 GraphQL 调用（不依赖浏览器 page fixture）。 */
async function gql(
  url: string,
  query: string,
  variables?: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
    signal: AbortSignal.timeout(15000),
  });
  return { status: res.status, body: await res.json() };
}

for (const svc of SERVICES) {
  test(`T-OBS20 ${svc.key} 首屏日志单行 JSON（level/time/service/msg）`, async () => {
    const lines = (logLines(svc) ?? []).filter((l) => l.trim() !== '');
    test.skip(lines.length === 0, `未获取到 ${svc.key} 日志。${LOG_GUIDE}`);

    const bad: string[] = [];
    for (const [i, line] of lines.slice(0, 50).entries()) {
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(line) as Record<string, unknown>;
      } catch {
        bad.push(`line ${i + 1}: JSON.parse 失败 → ${line.slice(0, 160)}`);
        continue;
      }
      for (const field of ['level', 'time', 'service', 'msg']) {
        if (typeof rec[field] !== 'string' || (rec[field] as string).length === 0) {
          bad.push(`line ${i + 1}: 缺少非空字符串字段 ${field} → ${line.slice(0, 160)}`);
        }
      }
      if (typeof rec.time === 'string' && Number.isNaN(Date.parse(rec.time))) {
        bad.push(`line ${i + 1}: time 不可解析 → ${String(rec.time)}`);
      }
    }
    expect(bad, `${svc.key} 首屏日志不符合单行 JSON 契约（contracts/observability.md 字段字典）:\n${bad.join('\n')}`).toEqual([]);
  });
}

/**
 * 归一化管理员口令并返回 admin token（不依赖浏览器）：
 * 优先 `MONGODB_URI` 直改哈希为 ADMIN_TEST_PASSWORD（helpers.forceAdminPassword），
 * 否则用 `ADMIN_INITIAL_PASSWORD` 初始口令登录（mustChangePassword 时走 changeAdminPassword）。
 * 两者都不可用返回 undefined，调用方 skip。
 */
async function ensureAdminToken(): Promise<string | undefined> {
  const candidates: string[] = [];
  try {
    if (await forceAdminPassword(ADMIN_TEST_PASSWORD)) candidates.push(ADMIN_TEST_PASSWORD);
  } catch {
    // 无 MONGODB_URI：回落 ADMIN_INITIAL_PASSWORD
  }
  if (candidates.length === 0 && DEFAULT_ADMIN_PASSWORD) candidates.push(DEFAULT_ADMIN_PASSWORD);
  for (const password of candidates) {
    const login = await gql(
      ADMIN_API_URL,
      `mutation($u: String!, $p: String!) { adminLogin(username: $u, password: $p) { token admin { mustChangePassword } } }`,
      { u: 'admin', p: password },
    );
    const payload = login.body?.data?.adminLogin as { token?: string; admin?: { mustChangePassword?: boolean } } | undefined;
    if (!payload?.token) continue;
    if (!payload.admin?.mustChangePassword) return payload.token;
    const changed = await gql(
      ADMIN_API_URL,
      `mutation($o: String!, $n: String!) { changeAdminPassword(oldPassword: $o, newPassword: $n) { token } }`,
      { o: password, n: ADMIN_TEST_PASSWORD },
      payload.token,
    );
    const newToken = changed.body?.data?.changeAdminPassword?.token as string | undefined;
    if (newToken) return newToken;
  }
  return undefined;
}

test('T-OBS20 一次 GraphQL 请求的 trace_id 同时出现在 agent-api 与 admin-api 日志', async () => {
  const agentLog = logLines(SERVICES[0]);
  const adminLog = logLines(SERVICES[1]);
  test.skip(
    !agentLog || !adminLog,
    `trace 关联需要 agent-api 与 admin-api 日志可得。${LOG_GUIDE}\n` +
      '另需服务以 OTEL SDK 启动（OTEL_EXPORTER_OTLP_ENDPOINT，如 Aspire collector / compose otel-endpoint），否则日志无 trace_id 字段。',
  );

  // 快照请求前的 trace_id 集合，断言「本次」跨服务请求的新 trace_id 同现两边
  const agentBefore = traceIds(agentLog!);
  const adminBefore = traceIds(adminLog!);

  // 一次跨服务 GraphQL 请求（处理链路会从一个服务转发到另一个服务，traceparent 随 HTTP 传播）：
  // - Chain A（INTERNAL_API_TOKEN）：agent-api `cloudHostBillingQuote` → admin-api /internal/billing/price-quote；
  // - Chain B（admin 口令可归一化）：admin-api `adminCreateFrontUser` → agent-api POST /internal/users。
  let crossRequest: () => Promise<void> = async () => {
    throw new Error('cross-service request chain not initialized');
  };
  if (INTERNAL_API_TOKEN) {
    const username = `obs${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`;
    const res = await fetch(`${AGENT_BASE}/internal/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INTERNAL_API_TOKEN}` },
      body: JSON.stringify({ username, password: FRONT_USER_PASSWORD }),
    });
    if (!res.ok) throw new Error(`POST /internal/users 失败（${res.status}）: ${await res.text()}`);
    const login = await gql(
      API_URL,
      `mutation($u: String!, $p: String!) { login(username: $u, password: $p) { token } }`,
      { u: username, p: FRONT_USER_PASSWORD },
    );
    const token = login.body?.data?.login?.token as string | undefined;
    if (!token) throw new Error(`login 失败：${JSON.stringify(login.body?.errors ?? login.body)}`);
    crossRequest = async () => {
      // 一次 GraphQL 请求：agent-api 处理时转发 admin-api（跨服务，同 trace）
      await gql(API_URL, 'query { cloudHostBillingQuote { createCredits perMinuteCredits } }', undefined, token);
    };
  } else {
    const adminToken = await ensureAdminToken();
    test.skip(
      !adminToken,
      '无法构造跨服务请求：INTERNAL_API_TOKEN 未注入且管理员口令不可归一化。' +
        '请注入 INTERNAL_API_TOKEN（首选）或 ADMIN_INITIAL_PASSWORD / MONGODB_URI 后重跑。',
    );
    crossRequest = async () => {
      // 一次 GraphQL 请求：admin-api 处理时转发 agent-api /internal/users（跨服务，同 trace）
      await gql(
        ADMIN_API_URL,
        `mutation($u: String!, $p: String!) { adminCreateFrontUser(username: $u, password: $p) { id } }`,
        {
          u: `obs${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 4)}`,
          p: FRONT_USER_PASSWORD,
        },
        adminToken,
      );
    };
  }

  await crossRequest();

  // 日志落地/采集有延迟，轮询等待本次请求的新 trace_id 同现两边（最多 ~10s）
  const deadline = Date.now() + 10_000;
  let shared = new Set<string>();
  for (;;) {
    const agentIds = traceIds(logLines(SERVICES[0]) ?? []);
    const adminIds = traceIds(logLines(SERVICES[1]) ?? []);
    shared = new Set(
      [...agentIds].filter((id) => adminIds.has(id) && !agentBefore.has(id) && !adminBefore.has(id)),
    );
    if (shared.size > 0 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  expect(
    [...shared],
    '一次跨服务 GraphQL 请求后，agent-api 与 admin-api 日志中没有共同的新 trace_id。' +
      '请确认：① 服务以 OTEL SDK 启动（OTEL_EXPORTER_OTLP_ENDPOINT）；② 日志为全量非采样（OTEL_TRACES_SAMPLER_ARG=1）；' +
      '③ 转发链路（cloudHostBillingQuote→admin-api / adminCreateFrontUser→agent-api）可达。',
  ).not.toEqual([]);
});
