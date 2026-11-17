/**
 * 运行期模型清单（`ModelProvision`）解析与重写。
 *
 * 契约见 `contracts/cloud-controller-websocket.md` §2.13/§2.14：
 *
 * - 载荷**不含** baseURL/apiKey/凭据（D8）——凭据仍由已写入的配置（或进程 env）提供；
 * - `zag` 组恒存在（可为空 `models: []`）且恒首位；`zag` 显示名固定 `Agent Gear`（D4）；
 * - `contextLength` 仅正整数携带；
 * - 解析错误只报字段名/索引，**不回显原值**（避免模型名/凭据进入日志）。
 */

import type { PrepareHarnessType } from './env.js';

/** 平台渠道（global 模型）的 vendorId。 */
export const ZAG_VENDOR_ID = 'zag';

/** 平台渠道在云电脑内的显示名（与网关 `/v1/models` 的 `owned_by` 同口径）。 */
export const ZAG_DISPLAY_NAME = 'Agent Gear';

/** 单个模型条目。 */
export interface ModelProvisionModel {
  /** 模型名（云电脑内即 `models.<id>`）。 */
  id: string;
  /** 最长上下文 token 数（仅正整数携带；缺省表示未设置）。 */
  contextLength?: number;
}

/** 单个供应商分组。 */
export interface ModelProvisionProvider {
  /** `zag`（平台渠道）或用户供应商 id（`providerId`）。 */
  vendorId: string;
  /** 显示名：`zag` 恒为 `Agent Gear`，用户组为供应商名称。 */
  displayName: string;
  models: ModelProvisionModel[];
}

/** 运行期模型清单（全量替换语义）。 */
export interface ModelProvision {
  providers: ModelProvisionProvider[];
}

/** 模型清单结构非法（消息只含字段名/索引，不含原值）。 */
export class ModelProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelProvisionError';
  }
}

/** 旧服务端下发的扁平模型清单（`ZAG_MODEL_IDS` + `ZAG_MODEL_CONTEXT_LENGTHS`）。 */
export interface LegacyModelEnv {
  modelIds?: string[];
  modelContextLengths?: Record<string, number>;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 结构校验并归一 `ModelProvision`（来自事件载荷或 `ZAG_MODEL_PROVIDERS`）。
 *
 * 只做**结构**校验（不校验业务语义：组数/组序/同名去重由服务端保证）；
 * 非法时抛 `ModelProvisionError`，消息只含字段名与索引。
 */
export function parseModelProvision(raw: unknown): ModelProvision {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new ModelProvisionError('invalid model provision: must be valid JSON');
    }
  }
  if (!isRecord(value)) {
    throw new ModelProvisionError('invalid model provision: expected a JSON object');
  }

  const rawProviders = value.providers;
  if (!Array.isArray(rawProviders)) {
    throw new ModelProvisionError('invalid model provision: providers must be an array');
  }

  const providers: ModelProvisionProvider[] = [];
  const seenVendorIds = new Set<string>();
  rawProviders.forEach((rawProvider, providerIndex) => {
    const path = `providers[${providerIndex}]`;
    if (!isRecord(rawProvider)) {
      throw new ModelProvisionError(`invalid model provision: ${path} must be an object`);
    }
    const vendorId = nonEmptyString(rawProvider.vendorId);
    if (!vendorId) {
      throw new ModelProvisionError(`invalid model provision: ${path}.vendorId must be a non-empty string`);
    }
    if (seenVendorIds.has(vendorId)) {
      throw new ModelProvisionError(`invalid model provision: ${path}.vendorId duplicates an earlier group`);
    }
    seenVendorIds.add(vendorId);

    const displayName = nonEmptyString(rawProvider.displayName);
    if (!displayName) {
      throw new ModelProvisionError(
        `invalid model provision: ${path}.displayName must be a non-empty string`,
      );
    }

    const rawModels = rawProvider.models;
    if (!Array.isArray(rawModels)) {
      throw new ModelProvisionError(`invalid model provision: ${path}.models must be an array`);
    }

    const models: ModelProvisionModel[] = [];
    rawModels.forEach((rawModel, modelIndex) => {
      const modelPath = `${path}.models[${modelIndex}]`;
      if (!isRecord(rawModel)) {
        throw new ModelProvisionError(`invalid model provision: ${modelPath} must be an object`);
      }
      const id = nonEmptyString(rawModel.id);
      if (!id) {
        throw new ModelProvisionError(
          `invalid model provision: ${modelPath}.id must be a non-empty string`,
        );
      }
      const context = rawModel.contextLength;
      if (context !== undefined && !isPositiveInteger(context)) {
        throw new ModelProvisionError(
          `invalid model provision: ${modelPath}.contextLength must be a positive integer`,
        );
      }
      models.push(context === undefined ? { id } : { id, contextLength: context });
    });

    providers.push({ vendorId, displayName, models });
  });

  return { providers };
}

/**
 * 归一组序：`zag` 组恒首位且恒存在（缺省时补空组），`zag` 显示名固定 `Agent Gear`。
 * 不改动入参（返回新对象）。
 */
export function normalizeProvision(provision: ModelProvision): ModelProvision {
  // 浅拷贝：只复制 provider 对象与 models 数组，模型条目按不可变值使用（调用方不修改）。
  const zagIndex = provision.providers.findIndex((item) => item.vendorId === ZAG_VENDOR_ID);
  const zag: ModelProvisionProvider =
    zagIndex === -1
      ? { vendorId: ZAG_VENDOR_ID, displayName: ZAG_DISPLAY_NAME, models: [] }
      : { ...provision.providers[zagIndex], displayName: ZAG_DISPLAY_NAME };
  const rest = provision.providers
    .filter((_, index) => index !== zagIndex)
    .map((item) => ({ ...item, models: [...item.models] }));
  return { providers: [zag, ...rest] };
}

/** 旧字段投影（组序展开、同名/同 id 去重；`modelContextLengths` 仅含正整数项）。 */
export function projectToLegacy(provision: ModelProvision): {
  modelIds: string[];
  modelContextLengths: Record<string, number>;
} {
  const modelIds: string[] = [];
  const modelContextLengths: Record<string, number> = {};
  const seen = new Set<string>();
  for (const provider of provision.providers) {
    for (const model of provider.models) {
      const id = model.id.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      modelIds.push(id);
      if (isPositiveInteger(model.contextLength)) modelContextLengths[id] = model.contextLength;
    }
  }
  return { modelIds, modelContextLengths };
}

/**
 * 解析本次应使用的模型清单：
 *
 * 1. `ZAG_MODEL_PROVIDERS`（运行期事件链路）优先；
 * 2. 缺省由 `ZAG_MODEL_IDS` / `ZAG_MODEL_CONTEXT_LENGTHS` 合成单 `zag` 组（**向后兼容**）。
 */
export function resolveProvision(
  env: LegacyModelEnv & { modelProviders?: ModelProvision },
): ModelProvision {
  if (env.modelProviders) return normalizeProvision(env.modelProviders);
  const models: ModelProvisionModel[] = [];
  for (const rawId of env.modelIds ?? []) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id) continue;
    const context = env.modelContextLengths?.[id];
    models.push(isPositiveInteger(context) ? { id, contextLength: context } : { id });
  }
  return {
    providers: [{ vendorId: ZAG_VENDOR_ID, displayName: ZAG_DISPLAY_NAME, models }],
  };
}

/** 运行期重写需要的 env（凭据来自已写入配置或进程 env，不在载荷内）。 */
export interface ModelProvisionCredentialEnv {
  modelBaseUrl: string;
  modelApiKey: string;
}

export interface ApplyModelProvisionOptions {
  provision: ModelProvision;
  env: ModelProvisionCredentialEnv;
  /** 需要重写的 harness 类型（`ZAG_HARNESS_TYPES` 白名单结果）。 */
  types: PrepareHarnessType[];
  /** 覆盖 OpenCode 配置目录（测试/定制场景）。 */
  configDir?: string;
  /** 覆盖 dsh home（测试/定制场景）。 */
  dshHome?: string;
  /** 覆盖 opencode vendor 状态文件（缺省 `~/.zag/model-providers-state.json`）。 */
  statePath?: string;
  /** 状态文件写失败回调（缺省仅告警，不影响配置写入）。 */
  onStateWriteError?: (error: Error) => void;
}

/** 单个类型应用失败（消息已脱敏，仅含路径/字段名）。 */
export interface ApplyModelProvisionError {
  type: PrepareHarnessType;
  message: string;
}

export interface ApplyModelProvisionResult {
  /** 实际重写成功的 harness 类型（无 harness 类型时为空数组）。 */
  appliedTypes: PrepareHarnessType[];
  errors: ApplyModelProvisionError[];
}

/**
 * 按模型清单重写各类 harness 配置（**不执行 CLI 硬校验**，供运行期事件复用）：
 *
 * - `opencode` → `opencode.jsonc` 的 `providers.<vendorId>`（含差集清理）；
 * - `deepseek_harness` → `cordis.patch.yml` 的 `llm-pi-ai.config.providers` 全量多 vendor；
 * - 任一类型失败不影响其余类型（逐类型独立 try/catch）；错误消息不含凭据。
 */
export async function applyModelProvision(
  options: ApplyModelProvisionOptions,
): Promise<ApplyModelProvisionResult> {
  const provision = normalizeProvision(options.provision);
  const types = [...new Set(options.types)];
  const appliedTypes: PrepareHarnessType[] = [];
  const errors: ApplyModelProvisionError[] = [];

  if (types.length === 0) return { appliedTypes, errors };

  const env = options.env;
  if (!env.modelBaseUrl || !env.modelApiKey) {
    const message =
      'missing required environment variable(s): ZAG_MODEL_BASE_URL, ZAG_MODEL_API_KEY';
    return { appliedTypes, errors: types.map((type) => ({ type, message })) };
  }

  for (const type of types) {
    try {
      if (type === 'opencode') {
        const { writeOpencodeConfig } = await import('./opencode-config.js');
        await writeOpencodeConfig({
          env,
          provision,
          configDir: options.configDir,
          statePath: options.statePath,
          onStateWriteError: options.onStateWriteError,
        });
      } else {
        const { writeDshConfig } = await import('./dsh-config.js');
        await writeDshConfig({ env, provision, dshHome: options.dshHome });
      }
      appliedTypes.push(type);
    } catch (error) {
      errors.push({ type, message: (error as Error).message });
    }
  }

  return { appliedTypes, errors };
}


