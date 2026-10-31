// GENERATED FROM packages/observability/src/logger.ts — DO NOT EDIT

/**
 * 统一结构化日志（pino 单行 JSON，同步写 fd 1）。
 *
 * - 字段字典 / env 契约见 `contracts/observability.md`；
 * - `mixin()` 是 `trace_id`/`requestId` 等上下文字段的**唯一注入点**，业务代码不手工传；
 * - 服务名与版本由 `package.json` 自解析（vendored 副本零 per-package 定制，见 F9/D2）；
 * - 调用签名统一 pino 原生 `logger.<level>(objOrMsg, msg?)`，错误对象进 `err` 字段。
 */
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino, {
  type DestinationStream,
  type Logger as PinoLogger,
} from 'pino';
import { readContext } from './log-context.js';
import { currentTraceIds } from './trace.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** pino 调用面统一类型（4 方法）；测试可注入 fake logger。 */
export type ObservationLogger = Pick<PinoLogger, 'debug' | 'info' | 'warn' | 'error'>;

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** 脱敏名单（contracts/observability.md §6.1 全量），censor = `[REDACTED]`。 */
export const REDACT_PATHS: string[] = [
  'req.headers.authorization', 'req.headers.cookie',
  'headers.authorization', 'headers.cookie',
  'authorization', 'cookie',
  'token', 'accessToken', 'refreshToken', 'idToken',
  'password', 'passwordHash', 'secret', 'clientSecret', 'privateKey',
  'apiKey', 'modelApiKey',
  '*.token', '*.password', '*.secret', '*.apiKey', '*.authorization',
  'secrets', 'secrets.*',
  'err.config.headers.authorization',
];

/** 解析 `LOG_LEVEL`；非法/缺省回落 `info`（契约 §3）。 */
export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === 'debug' ||
    normalized === 'info' ||
    normalized === 'warn' ||
    normalized === 'error'
    ? normalized
    : DEFAULT_LOG_LEVEL;
}

interface PackageMeta {
  name: string;
  version: string;
}

/**
 * 自解析服务名/版本：向上寻找最近的 `package.json`（vendored 副本的 `../../package.json`
 * 即包根；单源目录无 package.json 时回落到兜底值）。文件保持逐字节全等（D2）。
 */
function resolvePackageMeta(): PackageMeta {
  let dir = dirname(fileURLToPath(import.meta.url));
  const require = createRequire(import.meta.url);
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = require(join(dir, 'package.json')) as Partial<PackageMeta>;
      if (pkg && typeof pkg.name === 'string') {
        return { name: pkg.name, version: typeof pkg.version === 'string' ? pkg.version : '0.0.0' };
      }
    } catch {
      // 继续向上
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { name: 'observability', version: '0.0.0' };
}

const pkgMeta = resolvePackageMeta();

/** 服务标识（`service` 字段来源）：`OTEL_SERVICE_NAME` ?? `package.json.name`。 */
export const SERVICE_NAME: string = process.env.OTEL_SERVICE_NAME ?? pkgMeta.name;
/** 服务版本（`serviceVersion` 字段来源）：`package.json.version`。 */
export const SERVICE_VERSION: string = pkgMeta.version;

export interface CreateLoggerOptions {
  /** 测试注入内存 sink；缺省同步写 fd 1 */
  destination?: DestinationStream;
  /** 附加 child 字段（如 `component`） */
  component?: string;
  /** 覆盖 pretty 开关（缺省读 `LOG_PRETTY=1`） */
  pretty?: boolean;
  /** 覆盖级别（缺省读 `LOG_LEVEL`，非法回落 info） */
  level?: LogLevel;
}

function resolveDestination(opts: CreateLoggerOptions, warn: (msg: string) => void): DestinationStream {
  const defaultStream = opts.destination ?? pino.destination({ dest: 1, sync: true });
  const wantPretty = opts.pretty ?? process.env.LOG_PRETTY === '1';
  if (!wantPretty) return defaultStream;
  if (process.env.NODE_ENV === 'production') {
    warn('LOG_PRETTY ignored in production (JSON output enforced)');
    return defaultStream;
  }
  if (opts.destination) return defaultStream; // 测试注入 sink 时不做 pretty 转换
  try {
    // 动态解析：pino-pretty 仅 devDependencies，缺失时降级 JSON（D4）
    const require = createRequire(import.meta.url);
    require.resolve('pino-pretty');
    return pino.transport({ target: 'pino-pretty' }) as unknown as DestinationStream;
  } catch {
    warn('pino-pretty unavailable, falling back to JSON output');
    return defaultStream;
  }
}

/**
 * 创建 logger。`timestamp` ISO、`msg` 为消息键、级别为字符串、`err` 走 stdSerializers；
 * `mixin()` 自动合并日志上下文与 trace id。
 */
export function createLogger(opts: CreateLoggerOptions = {}): PinoLogger {
  const level = opts.level ?? parseLogLevel(process.env.LOG_LEVEL);
  let pendingWarning: string | undefined;
  const destination = resolveDestination(opts, (msg) => {
    pendingWarning = msg;
  });
  const instance = pino(
    {
      level,
      base: {
        service: SERVICE_NAME,
        serviceVersion: SERVICE_VERSION,
        env: process.env.NODE_ENV ?? 'development',
        hostname: hostname(),
        pid: process.pid,
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      messageKey: 'msg',
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      serializers: { err: pino.stdSerializers.err },
      mixin() {
        const ctx = readContext();
        const { traceId, spanId } = currentTraceIds();
        return { ...ctx, ...(traceId ? { trace_id: traceId, span_id: spanId } : {}) };
      },
    },
    destination,
  );
  if (pendingWarning) {
    // 降级/忽略告警：每个 logger 实例只告警一次，不随日志刷屏（T-OBS6）
    instance.warn({ component: 'observability' }, pendingWarning);
  }
  return opts.component ? instance.child({ component: opts.component }) : instance;
}

/** 进程级单例（业务代码用 `logger.child({ component })` 派生）。 */
export const logger: PinoLogger = createLogger();
