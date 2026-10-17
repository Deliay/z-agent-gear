import dotenv from 'dotenv';
import { parseLogLevel, type LogLevel } from '../logger.js';

dotenv.config();

export interface AppConfig {
  port: number;
  mongodbUri: string;
  internalApiToken: string;
  k8sNamespace: string;
  workerImage: string;
  publicWsEndpoint: string;
  connectTimeoutMs: number;
  k8sEnabled: boolean;
  runtimeClassName: string;
  /** 单条 init 脚本超时（`WORKLOAD_INIT_TIMEOUT_MS`，默认 300000），随 `workload:run` 下发。 */
  workloadInitTimeoutMs: number;
  /** post 批次共享总预算（`WORKLOAD_POST_BUDGET_MS`，默认 90000）。 */
  workloadPostBudgetMs: number;
  /** 单条日志存储上限（`WORKLOAD_LOG_MAX_BYTES`，默认 262144，截断保留尾部）。 */
  workloadLogMaxBytes: number;
  /** 日志级别（`LOG_LEVEL`，默认 info；排查回连时设 debug）。 */
  logLevel: LogLevel;
}

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * 读取正整数配置：缺省取 fallback；显式提供但非法（非数字/<=0）时 fail-fast，
 * 避免错误的宽限/预算在运行期静默放大或截断执行链路。
 */
function toPositiveIntStrict(value: string | undefined, envName: string, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${envName}: expected a positive integer, got "${value}"`);
  }
  return parsed;
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value.toLowerCase() === 'true' || value === '1';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: toInt(env.PORT, 4003),
    mongodbUri:
      env.MONGODB_URI ||
      env.MONGODB_CONNECTION_STRING ||
      'mongodb://localhost:27017/agent-gear',
    internalApiToken: env.INTERNAL_API_TOKEN ?? '',
    k8sNamespace: env.K8S_NAMESPACE ?? '',
    workerImage: env.WORKER_IMAGE ?? '',
    publicWsEndpoint: env.PUBLIC_WS_ENDPOINT ?? '',
    connectTimeoutMs: toInt(env.CONNECT_TIMEOUT_MS, 300000),
    k8sEnabled: toBool(env.K8S_ENABLED, true),
    runtimeClassName: env.RUNTIME_CLASS_NAME || 'sysbox-runc',
    workloadInitTimeoutMs: toPositiveIntStrict(
      env.WORKLOAD_INIT_TIMEOUT_MS,
      'WORKLOAD_INIT_TIMEOUT_MS',
      300000,
    ),
    workloadPostBudgetMs: toPositiveIntStrict(
      env.WORKLOAD_POST_BUDGET_MS,
      'WORKLOAD_POST_BUDGET_MS',
      90000,
    ),
    workloadLogMaxBytes: toPositiveIntStrict(
      env.WORKLOAD_LOG_MAX_BYTES,
      'WORKLOAD_LOG_MAX_BYTES',
      262144,
    ),
    logLevel: parseLogLevel(env.LOG_LEVEL),
  };
}

const REQUIRED_KEYS: Array<[keyof AppConfig, string]> = [
  ['internalApiToken', 'INTERNAL_API_TOKEN'],
  ['k8sNamespace', 'K8S_NAMESPACE'],
  ['workerImage', 'WORKER_IMAGE'],
  ['publicWsEndpoint', 'PUBLIC_WS_ENDPOINT'],
];

/** INTERNAL_API_TOKEN 最小长度（问题 10：拒绝弱令牌）。 */
export const MIN_INTERNAL_TOKEN_LENGTH = 16;

/** 已知公开/示例令牌，任何环境都不允许（问题 10，CWE-798 同类）。 */
export const FORBIDDEN_INTERNAL_TOKENS: readonly string[] = [
  'change-me-internal-token',
  'change-me',
  'changeme',
  'internal-api-token',
  'dev-internal-token-change-in-production',
  'dev-internal-token',
  'secret',
  'token',
  'password',
];

/**
 * 归一化令牌用于 deny-list 比对：去除首尾空白 + 统一小写 + 去除内部空白，
 * 使 `CHANGE-ME-INTERNAL-TOKEN`、` change-me-internal-token `、`change -me` 等
 * 同源变体无法绕过弱令牌名单（建议 C）。
 */
function normalizeForDenylist(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * Fail-fast 校验关键运行时配置，缺失即抛错，绝不静默兜底。
 * 额外拒绝过短或已知示例令牌，避免按文档落地即形成「入口可达 + 令牌公开」的内部 API。
 */
export function assertRuntimeConfig(cfg: AppConfig): void {
  const missing = REQUIRED_KEYS.filter(([key]) => !cfg[key]).map(([, envName]) => envName);
  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
  if (cfg.internalApiToken.length < MIN_INTERNAL_TOKEN_LENGTH) {
    throw new Error(
      `INTERNAL_API_TOKEN must be at least ${MIN_INTERNAL_TOKEN_LENGTH} characters`,
    );
  }
  const normalizedToken = normalizeForDenylist(cfg.internalApiToken);
  const isForbidden = FORBIDDEN_INTERNAL_TOKENS.some(
    (forbidden) => normalizeForDenylist(forbidden) === normalizedToken,
  );
  if (isForbidden) {
    throw new Error('INTERNAL_API_TOKEN must not use a known example/default value');
  }
}

export const config: AppConfig = loadConfig();
