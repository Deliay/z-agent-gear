/**
 * worker（`agent-gear`）注册版本门禁：严格三段数字解析 + 数字段比较。
 *
 * 设计约束（见 `docs/engineering/plan/20261017-feat-controller-version-requirement.md`）：
 * - 最低版本与 supported major 是与服务端协议能力绑定的**代码常量**，不新增环境变量；
 * - 不引入 semver 依赖：只接受 `major.minor.patch` 三段数字（每段 1~9 位、无前导零），
 *   按数字比较而非字典序（`2.10.0 > 2.2.0`）；
 * - 纯函数、零 IO，供 `socketio-gateway` 在注册副作用之前调用。
 */

/** 本期最低兼容的 worker 版本（工作负载能力自 2.2.0 起提供）。 */
export const MIN_WORKER_VERSION = '2.2.0';

/**
 * 云电脑（`purpose=harness`）最低兼容版本：双连接 + `harness prepare` 自 2.5.0 起提供。
 * 普通容器门禁不上调（仍为 `MIN_WORKER_VERSION`），按 purpose 分流。
 */
export const MIN_HARNESS_WORKER_VERSION = '2.6.0';

/** Kimi Code harness 最低兼容版本：使用前 `kimi login` 登录闸门自 2.8.0 起提供。 */
export const MIN_KIMI_HARNESS_WORKER_VERSION = '2.8.0';

/** DeepSeek Harness 最低兼容版本：`harness prepare` 的 deepseek_harness 注入分流自 2.9.0 起提供。 */
export const MIN_DEEPSEEK_HARNESS_WORKER_VERSION = '2.9.0';

/**
 * 按 harness 类型细分的最低版本（计划 §3 A7）：仅列出的类型才上调，
 * 未列出的类型沿用 `MIN_HARNESS_WORKER_VERSION`（仅 opencode 的运行仍为 2.6.0）。
 */
export const MIN_HARNESS_VERSION_BY_TYPE: Record<string, string> = {
  kimi_code: MIN_KIMI_HARNESS_WORKER_VERSION,
  deepseek_harness: MIN_DEEPSEEK_HARNESS_WORKER_VERSION,
};

/** 本期支持的 worker major 版本。 */
export const SUPPORTED_MAJOR = 2;

/** 版本串长度上限：超长直接拒绝，避免日志污染与无谓解析。 */
const MAX_VERSION_LENGTH = 64;

/** 严格三段数字：每段 1~9 位、无前导零（`0` 本身允许）。 */
const VERSION_PATTERN = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export interface ParsedWorkerVersion {
  ok: true;
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export interface InvalidWorkerVersion {
  ok: false;
  reason: 'missing' | 'malformed';
  raw: unknown;
}

export type WorkerVersionParseResult = ParsedWorkerVersion | InvalidWorkerVersion;

export type UnsupportedWorkerVersionReason =
  | 'missing'
  | 'malformed'
  | 'unsupported-major'
  | 'below-minimum';

export interface WorkerVersionSupport {
  supported: boolean;
  reason: 'supported' | UnsupportedWorkerVersionReason;
  parsed?: WorkerVersionParseResult;
}

/**
 * 解析 worker 上报版本。
 * 缺失（`undefined` / `null` / 空串）归为 `missing`，其余非法形态归为 `malformed`。
 */
export function parseWorkerVersion(raw: unknown): WorkerVersionParseResult {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: false, reason: 'missing', raw };
  }
  if (typeof raw !== 'string' || raw.length > MAX_VERSION_LENGTH) {
    return { ok: false, reason: 'malformed', raw };
  }
  const match = VERSION_PATTERN.exec(raw);
  if (!match) {
    return { ok: false, reason: 'malformed', raw };
  }
  return {
    ok: true,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw,
  };
}

function compareVersions(
  a: { major: number; minor: number; patch: number },
  b: { major: number; minor: number; patch: number },
): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * 判定 worker 上报版本是否在兼容范围：可解析 → major 匹配 → `>= minimum`。
 * `minimum` / `supportedMajor` 仅供测试显式覆盖，生产调用使用默认常量。
 */
export function isSupportedWorkerVersion(
  raw: unknown,
  minimum: string = MIN_WORKER_VERSION,
  supportedMajor: number = SUPPORTED_MAJOR,
): WorkerVersionSupport {
  const parsed = parseWorkerVersion(raw);
  if (!parsed.ok) {
    return { supported: false, reason: parsed.reason, parsed };
  }
  if (parsed.major !== supportedMajor) {
    return { supported: false, reason: 'unsupported-major', parsed };
  }
  const min = parseWorkerVersion(minimum);
  if (!min.ok || compareVersions(parsed, min) < 0) {
    return { supported: false, reason: 'below-minimum', parsed };
  }
  return { supported: true, reason: 'supported', parsed };
}

/**
 * 取两个三段版本中较大的一个（字符串原样返回，便于落库/契约透出）。
 * 仅用于已通过严格格式校验的版本串（`internal-api` 的 `agentGearMinVersion`）；
 * 任一侧非法时回退 `fallback`（调用方保证合法时不会触发）。
 */
export function maxWorkerVersion(a: string, b: string, fallback = MIN_HARNESS_WORKER_VERSION): string {
  const parsedA = parseWorkerVersion(a);
  const parsedB = parseWorkerVersion(b);
  if (!parsedA.ok || !parsedB.ok) return parsedA.ok ? a : parsedB.ok ? b : fallback;
  return compareVersions(parsedA, parsedB) >= 0 ? a : b;
}

/**
 * 按 harness 类型取最低版本（计划 §3 A7）：逐类型与
 * `MIN_HARNESS_VERSION_BY_TYPE` 比对后取最大，缺省/未知类型回退
 * `MIN_HARNESS_WORKER_VERSION`（仅 opencode → 2.6.0；含 kimi_code → 2.8.0；
 * 含 deepseek_harness → 2.9.0）。
 */
export function harnessMinVersion(harnessTypes: readonly string[]): string {
  let minimum: string = MIN_HARNESS_WORKER_VERSION;
  for (const harnessType of harnessTypes) {
    const required = MIN_HARNESS_VERSION_BY_TYPE[harnessType];
    if (required) minimum = maxWorkerVersion(minimum, required);
  }
  return minimum;
}

/**
 * 判定云电脑（`purpose=harness`）上报版本是否兼容：`>=MIN_HARNESS_WORKER_VERSION` 且 major 为 2。
 * 复用与普通容器完全相同的解析/比较实现，仅最低版本不同。
 */
export function isSupportedHarnessWorkerVersion(
  raw: unknown,
  supportedMajor: number = SUPPORTED_MAJOR,
): WorkerVersionSupport {
  return isSupportedWorkerVersion(raw, MIN_HARNESS_WORKER_VERSION, supportedMajor);
}

/**
 * 日志脱敏：移除控制字符、截断到 64 字符；非字符串或清洗后为空时回退 `unknown`。
 * 仅用于日志/错误文案，不参与版本判定。
 */
export function sanitizeVersionForLog(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, MAX_VERSION_LENGTH);
  return cleaned.length > 0 ? cleaned : 'unknown';
}
