/**
 * 模型下发载荷 `ModelProvision`（唯一构建口径）。
 *
 * 同一份载荷同时服务两条链路：
 * 1. 创建期快照：`cloud-host-service.create` 写入 `secrets.modelProviders`（旧字段 = 投影）；
 * 2. 运行期推送：`cloud-host-model-push` 逐台重算后经
 *    `POST /internal/containers/:id/harness-models` 下发。
 *
 * 契约见 `contracts/cloud-controller-websocket.md` §2.13 与实现计划 §3.1。
 * 本模块为纯函数（不 import Mongoose / logger），便于逐条锁定不变量。
 */

/** 平台组 vendorId（恒首位，可为空 `models: []`，D4）。 */
export const ZAG_VENDOR_ID = 'zag';

/** 平台组显示名（与网关 `owned_by` 同口径，D17）。 */
export const ZAG_DISPLAY_NAME = 'Agent Gear';

export interface ModelProvisionModel {
  id: string;
  /** 仅正整数携带；未设置时该键不出现（§3.1）。 */
  contextLength?: number;
}

export interface ModelProvisionProvider {
  vendorId: string;
  displayName: string;
  models: ModelProvisionModel[];
}

export interface ModelProvision {
  providers: ModelProvisionProvider[];
}

/** `ModelService.findAll()` 条目（只取构建所需字段，便于测试构造）。 */
export interface ProvisionModelInput {
  name?: unknown;
  contextLength?: unknown;
  isEnabled?: unknown;
  scope?: unknown;
  providerId?: unknown;
}

/** `ProviderService.findAll()` 条目（只取构建所需字段）。 */
export interface ProvisionProviderInput {
  id: string;
  name?: unknown;
  isEnabled?: unknown;
  createdAt?: unknown;
}

/** 旧字段投影（旧 worker 仍消费 `modelIds` / `modelContextLengths`）。 */
export interface ProvisionLegacyProjection {
  modelIds: string[];
  modelContextLengths: Record<string, number>;
}

/** 仅正整数携带（0/负数/小数/字符串/NaN → 未设置），与创建期旧实现逐字一致。 */
export function toPositiveContextLength(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function providerObjectId(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function providerCreatedAt(value: unknown): number {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : 0;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : 0;
  }
  return 0;
}

/**
 * 构建下发载荷（§3.1 全部不变量）：
 * - `zag` 组恒存在、恒首位，承载启用中的 global 模型（provider 状态不参与，F3/F9）；
 * - 用户模型按 `providerId` 分组，`vendorId=providerId`、`displayName=provider.name`；
 * - 组序按 provider `createdAt` 升序（同刻以 `_id` 兜底，D5）；
 * - 组内保持 `findAll()` 顺序（`sortOrder, createdAt`）；
 * - 模型名全局唯一：global 先占位，同名 user 模型不出现（D6）；
 * - `contextLength` 仅正整数携带；同名保留首个正整数；
 * - 剔除禁用模型与 provider 缺失/禁用的 user 模型（D7）。
 */
export function buildModelProvision(
  models: ProvisionModelInput[],
  providers: ProvisionProviderInput[],
): ModelProvision {
  const providersById = new Map<string, ProvisionProviderInput>();
  for (const provider of providers) {
    const id = providerObjectId(provider?.id);
    if (!id || providersById.has(id)) continue;
    providersById.set(id, provider);
  }

  const zag: ModelProvisionProvider = {
    vendorId: ZAG_VENDOR_ID,
    displayName: ZAG_DISPLAY_NAME,
    models: [],
  };
  const groups = new Map<string, ModelProvisionProvider>();
  const modelsByName = new Map<string, ModelProvisionModel>();

  // 同名保留首个正整数：先占位者可能没有 contextLength，后续同名条目补上首个有效值。
  const pushModel = (group: ModelProvisionProvider, name: string, rawContextLength: unknown) => {
    const contextLength = toPositiveContextLength(rawContextLength);
    const existing = modelsByName.get(name);
    if (existing) {
      if (existing.contextLength === undefined && contextLength !== undefined) {
        existing.contextLength = contextLength;
      }
      return;
    }
    const model: ModelProvisionModel = { id: name };
    if (contextLength !== undefined) model.contextLength = contextLength;
    modelsByName.set(name, model);
    group.models.push(model);
  };

  // 1) global 模型先占位（provider 状态不参与）
  for (const model of models) {
    if (model?.scope !== 'global') continue;
    if (model.isEnabled === false) continue;
    const name = normalizeName(model.name);
    if (!name) continue;
    pushModel(zag, name, model.contextLength);
  }

  // 2) 用户模型按 provider 分组（组序：createdAt 升序，同刻 _id 兜底）
  const orderedProviders = [...providersById.values()]
    .filter((provider) => provider.isEnabled !== false)
    .sort((a, b) => {
      const delta = providerCreatedAt(a.createdAt) - providerCreatedAt(b.createdAt);
      if (delta !== 0) return delta;
      const left = providerObjectId(a.id);
      const right = providerObjectId(b.id);
      if (left === right) return 0;
      return left < right ? -1 : 1;
    });

  for (const provider of orderedProviders) {
    const providerId = providerObjectId(provider.id);
    const group = groups.get(providerId) ?? {
      vendorId: providerId,
      displayName: normalizeName(provider.name),
      models: [],
    };
    for (const model of models) {
      if (model?.scope === 'global') continue;
      if (model?.isEnabled === false) continue;
      if (providerObjectId(model?.providerId) !== providerId) continue;
      const name = normalizeName(model?.name);
      if (!name) continue;
      pushModel(group, name, model?.contextLength);
    }
    if (group.models.length > 0) groups.set(providerId, group);
  }

  return { providers: [zag, ...groups.values()] };
}

/** 按组序展开模型 id（同名/同 id 去重，保留首个位置）。 */
export function flattenModelIds(provision: ModelProvision): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const provider of provision.providers) {
    for (const model of provider.models) {
      const id = normalizeName(model?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** 按组序展开上下文长度（仅正整数项，同名只保留首个）。 */
export function flattenContextLengths(provision: ModelProvision): Record<string, number> {
  const result: Record<string, number> = {};
  for (const provider of provision.providers) {
    for (const model of provider.models) {
      const id = normalizeName(model?.id);
      if (!id) continue;
      if (result[id] !== undefined) continue;
      const contextLength = toPositiveContextLength(model?.contextLength);
      if (contextLength === undefined) continue;
      result[id] = contextLength;
    }
  }
  return result;
}

/**
 * 旧字段投影：`modelIds` 按组序展开去重、`modelContextLengths` 仅含正整数项。
 * 创建期 `secrets.modelIds/modelContextLengths` 与推送侧的旧字段均由此派生（D1）。
 */
export function projectProvision(provision: ModelProvision): ProvisionLegacyProjection {
  return {
    modelIds: flattenModelIds(provision),
    modelContextLengths: flattenContextLengths(provision),
  };
}
