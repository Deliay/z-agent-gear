/**
 * harness（OpenCode 云电脑）初始化环境校验。
 *
 * 只读取 `harness prepare` 需要的变量；缺失/非法时一次性列出**变量名**，
 * 绝不回显其它 env 的值（尤其 `ZAG_MODEL_API_KEY` 等 secret）。
 */

/** harness prepare 需要的环境（已归一）。 */
export interface HarnessEnv {
  /** 模型网关地址（`ZAG_MODEL_BASE_URL`）。 */
  modelBaseUrl: string;
  /** 运行专用模型 Key（`ZAG_MODEL_API_KEY`，禁止打印）。 */
  modelApiKey: string;
  /** 可用模型 ID 列表（`ZAG_MODEL_IDS`，JSON 数组字符串，去空去重）。 */
  modelIds: string[];
  /** 模型 ID → 最长上下文 token 数（`ZAG_MODEL_CONTEXT_LENGTHS`，可选；缺省 `{}`）。 */
  modelContextLengths: Record<string, number>;
  /** 默认工作区（`ZAG_DEFAULT_WORKSPACE`）。 */
  defaultWorkspace: string;
}

/** env 校验失败（消息不含任何变量值）。 */
export class HarnessEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessEnvError';
  }
}

/** `harness prepare` 可处理的 harness 类型（与 `ZAG_HARNESS_TYPES` 的 harness slug 对齐）。 */
export const PREPARE_HARNESS_TYPES = ['opencode', 'deepseek_harness'] as const;

export type PrepareHarnessType = (typeof PREPARE_HARNESS_TYPES)[number];

/**
 * 解析 `ZAG_HARNESS_TYPES`（计划 §3 B5）：
 *
 * - 逗号分隔、trim、去重，保持输入顺序；
 * - 白名单过滤（`kimi_code` 等无 prepare 步骤的类型忽略）；
 * - 未设置/空串/过滤后为空 → `['opencode']`（旧 worker 手工执行零退化）。
 */
export function resolvePrepareTypes(env: NodeJS.ProcessEnv = process.env): PrepareHarnessType[] {
  const raw = typeof env.ZAG_HARNESS_TYPES === 'string' ? env.ZAG_HARNESS_TYPES : '';
  const allowed = new Set<string>(PREPARE_HARNESS_TYPES);
  const types: PrepareHarnessType[] = [];
  const seen = new Set<string>();
  for (const item of raw.split(',')) {
    const value = item.trim();
    if (!value || seen.has(value) || !allowed.has(value)) continue;
    seen.add(value);
    types.push(value as PrepareHarnessType);
  }
  return types.length > 0 ? types : ['opencode'];
}

function nonEmpty(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 解析 `ZAG_MODEL_IDS`：必须是字符串 JSON 数组；元素 trim 后去空、去重（保持原顺序）。
 *
 * - `[]` 合法（T-AG11：空数组仍写 `models:{}`）；
 * - 非数组/非法 JSON/含非字符串元素 → 明确报错（不输出原始值）。
 */
export function parseModelIds(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HarnessEnvError('ZAG_MODEL_IDS must be a JSON array of strings (invalid JSON)');
  }
  if (!Array.isArray(parsed)) {
    throw new HarnessEnvError('ZAG_MODEL_IDS must be a JSON array of strings');
  }
  if (!parsed.every((item) => typeof item === 'string')) {
    throw new HarnessEnvError('ZAG_MODEL_IDS must be a JSON array of strings (non-string element)');
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const item of parsed as string[]) {
    const value = item.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

/**
 * 解析 `ZAG_MODEL_CONTEXT_LENGTHS`（可选）：必须是「值为正整数」的 JSON object；
 * 键 trim 后去空。非法 JSON / 非 object / 值非正整数 → 明确报错（不输出原始值）。
 */
export function parseModelContextLengths(raw: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HarnessEnvError('ZAG_MODEL_CONTEXT_LENGTHS must be a JSON object of positive integers (invalid JSON)');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HarnessEnvError('ZAG_MODEL_CONTEXT_LENGTHS must be a JSON object of positive integers');
  }
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const id = key.trim();
    if (!id) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new HarnessEnvError('ZAG_MODEL_CONTEXT_LENGTHS must be a JSON object of positive integers (invalid value)');
    }
    result[id] = value;
  }
  return result;
}

/**
 * 读取并校验 harness env。
 *
 * 必需：`ZAG_MODEL_BASE_URL` / `ZAG_MODEL_API_KEY` / `ZAG_MODEL_IDS` / `ZAG_DEFAULT_WORKSPACE`
 * （云电脑 Job env 与 `workload:run.env` 均由 agent-api 注入，缺失说明编排不正确）。
 * 可选：`ZAG_MODEL_CONTEXT_LENGTHS`（缺省/空串归一为 `{}`；旧服务端不下发时优雅降级）。
 */
export function readHarnessEnv(env: NodeJS.ProcessEnv = process.env): HarnessEnv {
  const missing: string[] = [];
  const modelBaseUrl = nonEmpty(env.ZAG_MODEL_BASE_URL);
  if (!modelBaseUrl) missing.push('ZAG_MODEL_BASE_URL');
  const modelApiKey = nonEmpty(env.ZAG_MODEL_API_KEY);
  if (!modelApiKey) missing.push('ZAG_MODEL_API_KEY');
  const rawModelIds = nonEmpty(env.ZAG_MODEL_IDS);
  if (!rawModelIds) missing.push('ZAG_MODEL_IDS');
  const defaultWorkspace = nonEmpty(env.ZAG_DEFAULT_WORKSPACE);
  if (!defaultWorkspace) missing.push('ZAG_DEFAULT_WORKSPACE');

  if (missing.length > 0) {
    throw new HarnessEnvError(`missing required environment variable(s): ${missing.join(', ')}`);
  }

  const rawModelContextLengths = nonEmpty(env.ZAG_MODEL_CONTEXT_LENGTHS);

  return {
    modelBaseUrl,
    modelApiKey,
    modelIds: parseModelIds(rawModelIds),
    modelContextLengths: rawModelContextLengths ? parseModelContextLengths(rawModelContextLengths) : {},
    defaultWorkspace,
  };
}
