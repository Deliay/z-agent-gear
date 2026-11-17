/**
 * 运行期模型下发载荷 `ModelProvision`（契约 §2.13 / A.2.15）。
 *
 * 本文件是 cloud-controller 侧的**结构校验与投影**唯一口径：
 * - `parseModelProvisionPayload`：路由（A.2.15 请求体）与内部服务共用，避免两处校验漂移；
 * - `projectModelProvision`：把多 vendor 载荷投影为旧的扁平字段
 *   （`modelIds` / `modelContextLengths`），供旧 worker 与 `workload:run.env` 消费。
 *
 * 边界（计划 D8/D20）：
 * - **只做结构校验，不做业务语义校验**（`zag` 组是否首位、vendor 是否来自平台等由 agent-api 保证）；
 * - 载荷**不含** baseURL / apiKey / 任何凭据，本模块也不产生日志（错误文案不含载荷内容）。
 */

/** 单条模型：`contextLength` 仅正整数携带（未设置不出现该键）。 */
export interface ModelProvisionModel {
  id: string;
  contextLength?: number;
}

/** 单个 vendor 分组（平台组 `vendorId='zag'`，用户组 `vendorId=providerId`）。 */
export interface ModelProvisionProvider {
  vendorId: string;
  displayName: string;
  models: ModelProvisionModel[];
}

/** 全量模型清单（全量替换语义）。 */
export interface ModelProvision {
  providers: ModelProvisionProvider[];
}

/** 投影结果：旧字段（`secrets.modelIds` / `secrets.modelContextLengths`）。 */
export interface ModelProvisionProjection {
  /** 按组序展开、按 id 去重（保留首次出现）。 */
  modelIds: string[];
  /** 模型 ID → 最长上下文（同 id 保留首个正整数）。 */
  modelContextLengths: Record<string, number>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 结构校验 `ModelProvision`（契约 A.2.15）：
 * - `providers` 必须为数组（**允许空数组**）；
 * - `vendorId` / `displayName` 非空字符串；
 * - `models` 必须为数组，条目 `id` 非空字符串；
 * - `contextLength` 缺省（`undefined` / `null`）或正整数（0/负数/小数/字符串 → 非法）。
 *
 * 任一条不满足返回 `null`（调用方 400 `INVALID_MODEL_PROVISION`）。不校验业务语义。
 */
export function parseModelProvisionPayload(raw: unknown): ModelProvision | null {
  if (!isPlainObject(raw)) return null;
  const providers = raw.providers;
  if (!Array.isArray(providers)) return null;

  const parsedProviders: ModelProvisionProvider[] = [];
  for (const provider of providers) {
    if (!isPlainObject(provider)) return null;
    const vendorId = nonEmptyString(provider.vendorId);
    const displayName = nonEmptyString(provider.displayName);
    if (!vendorId || !displayName) return null;
    const models = provider.models;
    if (!Array.isArray(models)) return null;

    const parsedModels: ModelProvisionModel[] = [];
    for (const model of models) {
      if (!isPlainObject(model)) return null;
      const id = nonEmptyString(model.id);
      if (!id) return null;
      const rawContextLength = model.contextLength;
      if (rawContextLength === undefined || rawContextLength === null) {
        parsedModels.push({ id });
        continue;
      }
      if (
        typeof rawContextLength !== 'number' ||
        !Number.isInteger(rawContextLength) ||
        rawContextLength <= 0
      ) {
        return null;
      }
      parsedModels.push({ id, contextLength: rawContextLength });
    }

    parsedProviders.push({ vendorId, displayName, models: parsedModels });
  }

  return { providers: parsedProviders };
}

/**
 * 投影为旧字段：`modelIds` 按组序展开去重；`modelContextLengths` 仅携带正整数项
 * （同 id 以首次出现者为准）。与 agent-api 侧 `projectProvision` 同口径。
 */
export function projectModelProvision(provision: ModelProvision): ModelProvisionProjection {
  const modelIds: string[] = [];
  const seen = new Set<string>();
  const modelContextLengths: Record<string, number> = {};

  for (const provider of provision.providers) {
    for (const model of provider.models) {
      if (!seen.has(model.id)) {
        seen.add(model.id);
        modelIds.push(model.id);
      }
      if (
        typeof model.contextLength === 'number' &&
        Number.isInteger(model.contextLength) &&
        model.contextLength > 0 &&
        modelContextLengths[model.id] === undefined
      ) {
        modelContextLengths[model.id] = model.contextLength;
      }
    }
  }

  return { modelIds, modelContextLengths };
}
