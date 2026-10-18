import { CloudWorkload } from '../models/cloud-workload.js';
import { findStoredWorkloadLogs } from '../models/cloud-workload-log.js';

/** 契约 `CloudWorkloadParamField` 的服务端形态（枚举已大写，与 GraphQL 契约一致） */
export interface CloudWorkloadParamFieldDTO {
  key: string;
  label: string;
  type: 'SELECT' | 'MULTI_SELECT' | 'TEXT' | 'BOOLEAN';
  options: string[];
  defaultValue: unknown;
}

/** 契约 `CloudWorkload` 的服务端形态（时间为 ISO 字符串，脚本可空归一为 null） */
export interface CloudWorkloadDTO {
  id: string;
  name: string;
  initScript: string | null;
  postScript: string | null;
  paramSchema: CloudWorkloadParamFieldDTO[];
  dependsOnWorkloadIds: string[];
  isPreset: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 契约 `CloudWorkloadLog` 的服务端形态（枚举已大写、时间为 ISO 字符串/null） */
export interface CloudWorkloadLogDTO {
  id: string;
  containerId: string;
  workloadId: string;
  workloadName: string;
  phase: string;
  status: string;
  script: string;
  params: Record<string, unknown>;
  /** 本次启动该项是否为「必须」；历史记录缺省 false。 */
  required: boolean;
  exitCode: number | null;
  log: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** 契约 `CloudWorkloadParamFieldInput`（GraphQL enum 传入为大写，服务层归一为内部小写） */
export interface CloudWorkloadParamFieldInput {
  key: string;
  label: string;
  type: string;
  options?: string[] | null;
  defaultValue: unknown;
}

export interface CreateCloudWorkloadInput {
  name: string;
  initScript?: string | null;
  postScript?: string | null;
  paramSchema?: CloudWorkloadParamFieldInput[] | null;
  dependsOnWorkloadIds?: string[] | null;
}

export interface UpdateCloudWorkloadInput {
  name?: string;
  initScript?: string | null;
  postScript?: string | null;
  paramSchema?: CloudWorkloadParamFieldInput[] | null;
  dependsOnWorkloadIds?: string[] | null;
}

/** 名称 trim 后上限（裁决 12） */
export const WORKLOAD_NAME_MAX_LENGTH = 64;
/** 单脚本上限：16 KiB（裁决 12） */
export const WORKLOAD_SCRIPT_MAX_BYTES = 16 * 1024;
/** 参数数量上限（裁决 6） */
export const WORKLOAD_MAX_PARAMS = 20;
/** 参数 key 正则（裁决 6） */
export const WORKLOAD_PARAM_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** 参数 label 长度上限（裁决 6） */
export const WORKLOAD_PARAM_LABEL_MAX_LENGTH = 64;
/** 下拉可选项数量上限（裁决 6） */
export const WORKLOAD_PARAM_OPTIONS_MAX = 50;
/** 单个可选项字符数上限（裁决 6） */
export const WORKLOAD_PARAM_OPTION_MAX_LENGTH = 100;
/** TEXT 参数值字符数上限（裁决 6） */
export const WORKLOAD_PARAM_TEXT_MAX_LENGTH = 1024;
/** 依赖数量上限（裁决 6/9） */
export const WORKLOAD_MAX_DEPENDENCIES = 5;

/** 内部小写阶段 → GraphQL 大写枚举 */
const PHASE_TO_GQL: Record<string, string> = { init: 'INIT', post: 'POST' };
/** 内部小写状态 → GraphQL 大写枚举 */
const LOG_STATUS_TO_GQL: Record<string, string> = {
  pending: 'PENDING',
  running: 'RUNNING',
  success: 'SUCCESS',
  failed: 'FAILED',
  timeout: 'TIMEOUT',
};

/** 内部存储的参数字段类型（小写） */
type StoredParamType = 'select' | 'multi_select' | 'text' | 'boolean';
const STORED_PARAM_TYPES: readonly StoredParamType[] = ['select', 'multi_select', 'text', 'boolean'];

interface NormalizedParamField {
  key: string;
  label: string;
  type: StoredParamType;
  options: string[];
  defaultValue: unknown;
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** 空串/纯空白归一为 null，真实脚本原样保留 */
function normalizeScript(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.trim() === '' ? null : value;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * 校验收敛（裁决 12）：名称 trim 后 1~64 且唯一（唯一性由 DB 唯一索引兜底），
 * 脚本各自 ≤16 KiB，至少其一非空。抛出的错误文案与契约对齐。
 */
function assertName(name: string): void {
  if (!name) throw new Error('name is required');
  if (name.length > WORKLOAD_NAME_MAX_LENGTH) {
    throw new Error(`name must be at most ${WORKLOAD_NAME_MAX_LENGTH} characters`);
  }
}

function assertScripts(initScript: string | null, postScript: string | null): void {
  if (!initScript && !postScript) throw new Error('at least one script is required');
  if (initScript && byteLength(initScript) > WORKLOAD_SCRIPT_MAX_BYTES) {
    throw new Error('initScript must be at most 16 KiB');
  }
  if (postScript && byteLength(postScript) > WORKLOAD_SCRIPT_MAX_BYTES) {
    throw new Error('postScript must be at most 16 KiB');
  }
}

/** 按类型校验默认值（裁决 6），非法抛 `paramSchema[i].defaultValue is invalid`。 */
function assertParamDefault(
  type: StoredParamType,
  options: string[],
  value: unknown,
  path: string,
): unknown {
  switch (type) {
    case 'select':
      if (typeof value !== 'string' || !options.includes(value)) {
        throw new Error(`${path}.defaultValue is invalid`);
      }
      return value;
    case 'multi_select':
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && options.includes(item))) {
        throw new Error(`${path}.defaultValue is invalid`);
      }
      return [...new Set(value as string[])];
    case 'text':
      if (typeof value !== 'string' || value.length > WORKLOAD_PARAM_TEXT_MAX_LENGTH) {
        throw new Error(`${path}.defaultValue is invalid`);
      }
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new Error(`${path}.defaultValue is invalid`);
      }
      return value;
  }
}

/** 校验并归一单个参数字段（裁决 6）。错误文案带字段路径。 */
function normalizeParamField(field: CloudWorkloadParamFieldInput, index: number): NormalizedParamField {
  const path = `paramSchema[${index}]`;

  const key = String(field.key ?? '');
  if (!WORKLOAD_PARAM_KEY_PATTERN.test(key)) throw new Error(`${path}.key is invalid`);

  const label = String(field.label ?? '');
  if (label.length < 1 || label.length > WORKLOAD_PARAM_LABEL_MAX_LENGTH) {
    throw new Error(`${path}.label is invalid`);
  }

  const type = String(field.type ?? '').toLowerCase() as StoredParamType;
  if (!STORED_PARAM_TYPES.includes(type)) throw new Error(`${path}.type is invalid`);

  const options: string[] = [];
  if (type === 'select' || type === 'multi_select') {
    const rawOptions = field.options ?? [];
    if (
      !Array.isArray(rawOptions) ||
      rawOptions.length < 1 ||
      rawOptions.length > WORKLOAD_PARAM_OPTIONS_MAX
    ) {
      throw new Error(`${path}.options is invalid`);
    }
    const seen = new Set<string>();
    for (const option of rawOptions) {
      if (
        typeof option !== 'string' ||
        option.length < 1 ||
        option.length > WORKLOAD_PARAM_OPTION_MAX_LENGTH ||
        seen.has(option)
      ) {
        throw new Error(`${path}.options is invalid`);
      }
      seen.add(option);
      options.push(option);
    }
  }

  if (field.defaultValue === undefined || field.defaultValue === null) {
    throw new Error(`${path}.defaultValue is invalid`);
  }
  const defaultValue = assertParamDefault(type, options, field.defaultValue, path);

  return { key, label, type, options, defaultValue };
}

/**
 * 校验并归一 `paramSchema`（裁决 6）：数量 ≤20、key 正则且唯一、label 1~64、
 * options 仅下拉类型（1~50、去重、非空、单项 ≤100，其他类型归一为 []）、defaultValue 必填且合法。
 * 缺省/空视为无配置。
 */
export function normalizeParamSchema(
  input: CloudWorkloadParamFieldInput[] | null | undefined,
): NormalizedParamField[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error('paramSchema is invalid');
  if (input.length > WORKLOAD_MAX_PARAMS) throw new Error('too many parameters');

  const result: NormalizedParamField[] = [];
  const seenKeys = new Set<string>();
  input.forEach((field, index) => {
    const normalized = normalizeParamField(field, index);
    if (seenKeys.has(normalized.key)) throw new Error(`paramSchema[${index}].key is duplicated`);
    seenKeys.add(normalized.key);
    result.push(normalized);
  });
  return result;
}

/** 从已落库数据映射参数字段（更新时未提供 paramSchema 则沿用现状） */
function mapStoredParamSchema(value: unknown): NormalizedParamField[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const field = raw as Record<string, unknown>;
    return {
      key: String(field.key ?? ''),
      label: String(field.label ?? ''),
      type: String(field.type ?? '').toLowerCase() as StoredParamType,
      options: Array.isArray(field.options) ? (field.options as unknown[]).map(String) : [],
      defaultValue: field.defaultValue,
    };
  });
}

/** 输出映射：内部小写类型 → GraphQL 大写枚举 */
function mapParamSchemaOut(value: unknown): CloudWorkloadParamFieldDTO[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const field = raw as Record<string, unknown>;
    return {
      key: String(field.key ?? ''),
      label: String(field.label ?? ''),
      type: String(field.type ?? '').toUpperCase() as CloudWorkloadParamFieldDTO['type'],
      options: Array.isArray(field.options) ? (field.options as unknown[]).map(String) : [],
      defaultValue: field.defaultValue,
    };
  });
}

function normalizeParamsObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * 校验依赖（裁决 6）：≤5、存在、非自身、数组内去重；更新时 DFS 检测依赖环并返回环路径。
 * 返回去重后的依赖 ID 列表（保持首次出现顺序）。
 */
async function validateDependencies(rawIds: string[], selfId: string | null): Promise<string[]> {
  const ids = [...new Set(rawIds.map((id) => String(id)))];
  if (ids.length > WORKLOAD_MAX_DEPENDENCIES) throw new Error('too many dependencies');
  if (selfId && ids.includes(selfId)) throw new Error('workload cannot depend on itself');
  if (ids.length === 0) return [];

  const found = await CloudWorkload.find({ _id: { $in: ids } }).lean();
  const foundIds = new Set((found as Array<Record<string, unknown>>).map((doc) => String(doc._id)));
  for (const id of ids) {
    if (!foundIds.has(id)) throw new Error('dependency workload not found');
  }

  if (selfId) await assertNoDependencyCycle(selfId, ids);
  return ids;
}

/** DFS 检测依赖环（从当前工作负载出发，回到自身即视为环），错误含环路径。 */
async function assertNoDependencyCycle(selfId: string, depIds: string[]): Promise<void> {
  const all = await CloudWorkload.find({}, { dependsOnWorkloadIds: 1 }).lean();
  const graph = new Map<string, string[]>();
  for (const doc of all as Array<Record<string, unknown>>) {
    const deps = Array.isArray(doc.dependsOnWorkloadIds) ? (doc.dependsOnWorkloadIds as unknown[]) : [];
    graph.set(String(doc._id), deps.map(String));
  }
  // 以「更新后的依赖列表」为准
  graph.set(selfId, depIds);

  const stack: string[] = [];
  const visited = new Set<string>();
  const dfs = (id: string): void => {
    if (visited.has(id)) return;
    const cycleStart = stack.indexOf(id);
    if (cycleStart !== -1) {
      throw new Error(`dependency cycle detected: ${[...stack.slice(cycleStart), id].join(' -> ')}`);
    }
    stack.push(id);
    for (const dep of graph.get(id) ?? []) dfs(dep);
    stack.pop();
    visited.add(id);
  };
  dfs(selfId);
}

/**
 * 将内部 API 响应（A.6 JSON）或降级读取的 Mongo 文档（Date + `_id`）归一为
 * 契约 `CloudWorkloadLog` 形态（枚举大写、时间 ISO 字符串、可空字段归一、params 归一）。
 * 未知枚举回落安全值（沿用容器映射的防御口径），避免非法枚举打挂整条查询。
 */
export function mapWorkloadLog(raw: Record<string, unknown>): CloudWorkloadLogDTO {
  const rawId = raw.id ?? (raw._id as { toString(): string } | undefined);
  return {
    id: rawId === undefined || rawId === null ? '' : String(rawId),
    containerId:
      raw.containerId === undefined || raw.containerId === null ? '' : String(raw.containerId),
    workloadId:
      raw.workloadId === undefined || raw.workloadId === null ? '' : String(raw.workloadId),
    workloadName: (raw.workloadName as string | undefined) ?? '',
    phase: raw.phase ? (PHASE_TO_GQL[raw.phase as string] ?? 'INIT') : 'INIT',
    status: raw.status ? (LOG_STATUS_TO_GQL[raw.status as string] ?? 'FAILED') : 'FAILED',
    script: (raw.script as string | undefined) ?? '',
    params: normalizeParamsObject(raw.params),
    required: raw.required === true,
    exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
    log: (raw.log as string | undefined) ?? '',
    startedAt: toIso(raw.startedAt),
    finishedAt: toIso(raw.finishedAt),
  };
}

export class CloudWorkloadService {
  /** 全部工作负载（按创建时间倒序，最新在前） */
  async list(): Promise<CloudWorkloadDTO[]> {
    const docs = await CloudWorkload.find().sort({ createdAt: -1 }).lean();
    return docs.map((doc) => this.mapWorkload(doc as unknown as Record<string, unknown>));
  }

  async get(id: string): Promise<CloudWorkloadDTO | null> {
    const doc = await CloudWorkload.findById(id).lean();
    if (!doc) return null;
    return this.mapWorkload(doc as unknown as Record<string, unknown>);
  }

  /** 批量查询：按入参顺序返回，已删除（不存在）的省略（裁决 13，供 `CloudContainer.workloads`） */
  async getByIds(ids: string[]): Promise<CloudWorkloadDTO[]> {
    if (ids.length === 0) return [];
    const docs = await CloudWorkload.find({ _id: { $in: ids } }).lean();
    const byId = new Map(
      docs.map((doc) => [
        String((doc as { _id: { toString(): string } })._id),
        this.mapWorkload(doc as unknown as Record<string, unknown>),
      ]),
    );
    return ids
      .map((id) => byId.get(id))
      .filter((workload): workload is CloudWorkloadDTO => workload !== undefined);
  }

  async create(input: CreateCloudWorkloadInput): Promise<CloudWorkloadDTO> {
    const name = (input.name ?? '').trim();
    assertName(name);
    const initScript = normalizeScript(input.initScript);
    const postScript = normalizeScript(input.postScript);
    assertScripts(initScript, postScript);

    const paramSchema = normalizeParamSchema(input.paramSchema);
    const dependsOnWorkloadIds = await validateDependencies(
      (input.dependsOnWorkloadIds ?? []).map(String),
      null,
    );

    // 重名由 E11000 唯一索引错误抛出，resolver 统一映射
    const doc = await CloudWorkload.create({
      name,
      initScript,
      postScript,
      paramSchema,
      dependsOnWorkloadIds,
    });
    return this.mapWorkload(doc.toObject());
  }

  async update(id: string, input: UpdateCloudWorkloadInput): Promise<CloudWorkloadDTO | null> {
    // 合并式校验：需按「更新后的最终状态」判定脚本至少其一非空，故先读现状
    const existing = await CloudWorkload.findById(id).lean();
    if (!existing) return null;
    const current = existing as unknown as Record<string, unknown>;

    const name = input.name === undefined ? (current.name as string) : (input.name ?? '').trim();
    assertName(name);
    const initScript =
      input.initScript === undefined
        ? ((current.initScript as string | null | undefined) ?? null)
        : normalizeScript(input.initScript);
    const postScript =
      input.postScript === undefined
        ? ((current.postScript as string | null | undefined) ?? null)
        : normalizeScript(input.postScript);
    assertScripts(initScript, postScript);

    const paramSchema =
      input.paramSchema === undefined
        ? mapStoredParamSchema(current.paramSchema)
        : normalizeParamSchema(input.paramSchema);
    const dependsOnWorkloadIds =
      input.dependsOnWorkloadIds === undefined
        ? (Array.isArray(current.dependsOnWorkloadIds)
            ? (current.dependsOnWorkloadIds as unknown[]).map(String)
            : [])
        : await validateDependencies((input.dependsOnWorkloadIds ?? []).map(String), id);

    const doc = await CloudWorkload.findByIdAndUpdate(
      id,
      { name, initScript, postScript, paramSchema, dependsOnWorkloadIds },
      { new: true, lean: true },
    );
    if (!doc) return null;
    return this.mapWorkload(doc as unknown as Record<string, unknown>);
  }

  async delete(id: string): Promise<boolean> {
    const result = await CloudWorkload.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }

  /** 降级直读 Mongo（控制面不可达时）：返回契约形态的执行记录 */
  async listByContainerLogs(containerId: string): Promise<CloudWorkloadLogDTO[]> {
    const docs = await findStoredWorkloadLogs(containerId);
    return docs.map((doc) => mapWorkloadLog(doc));
  }

  private mapWorkload(doc: Record<string, unknown>): CloudWorkloadDTO {
    return {
      id: (doc._id as { toString(): string }).toString(),
      name: doc.name as string,
      initScript: (doc.initScript as string | null | undefined) ?? null,
      postScript: (doc.postScript as string | null | undefined) ?? null,
      paramSchema: mapParamSchemaOut(doc.paramSchema),
      dependsOnWorkloadIds: Array.isArray(doc.dependsOnWorkloadIds)
        ? (doc.dependsOnWorkloadIds as unknown[]).map(String)
        : [],
      isPreset: Boolean(doc.isPreset),
      createdAt: (doc.createdAt as Date).toISOString(),
      updatedAt: (doc.updatedAt as Date).toISOString(),
    };
  }
}

export const cloudWorkloadService = new CloudWorkloadService();
