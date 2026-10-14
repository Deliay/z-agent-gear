import dotenv from 'dotenv';

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
}

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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
  };
}

const REQUIRED_KEYS: Array<[keyof AppConfig, string]> = [
  ['internalApiToken', 'INTERNAL_API_TOKEN'],
  ['k8sNamespace', 'K8S_NAMESPACE'],
  ['workerImage', 'WORKER_IMAGE'],
  ['publicWsEndpoint', 'PUBLIC_WS_ENDPOINT'],
];

/**
 * Fail-fast 校验关键运行时配置，缺失即抛错，绝不静默兜底。
 */
export function assertRuntimeConfig(cfg: AppConfig): void {
  const missing = REQUIRED_KEYS.filter(([key]) => !cfg[key]).map(([, envName]) => envName);
  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
}

export const config: AppConfig = loadConfig();
