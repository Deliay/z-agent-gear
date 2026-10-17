import { CloudWorkload } from '../models/cloud-workload.js';
import { findStoredWorkloadLogs } from '../models/cloud-workload-log.js';

/** 契约 `CloudWorkload` 的服务端形态（时间为 ISO 字符串，脚本可空归一为 null） */
export interface CloudWorkloadDTO {
  id: string;
  name: string;
  initScript: string | null;
  postScript: string | null;
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
  exitCode: number | null;
  log: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CreateCloudWorkloadInput {
  name: string;
  initScript?: string | null;
  postScript?: string | null;
}

export interface UpdateCloudWorkloadInput {
  name?: string;
  initScript?: string | null;
  postScript?: string | null;
}

/** 名称 trim 后上限（裁决 12） */
export const WORKLOAD_NAME_MAX_LENGTH = 64;
/** 单脚本上限：16 KiB（裁决 12） */
export const WORKLOAD_SCRIPT_MAX_BYTES = 16 * 1024;

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

/**
 * 将内部 API 响应（A.6 JSON）或降级读取的 Mongo 文档（Date + `_id`）归一为
 * 契约 `CloudWorkloadLog` 形态（枚举大写、时间 ISO 字符串、可空字段归一）。
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

    // 重名由 E11000 唯一索引错误抛出，resolver 统一映射
    const doc = await CloudWorkload.create({ name, initScript, postScript });
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

    const doc = await CloudWorkload.findByIdAndUpdate(
      id,
      { name, initScript, postScript },
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
      createdAt: (doc.createdAt as Date).toISOString(),
      updatedAt: (doc.updatedAt as Date).toISOString(),
    };
  }
}

export const cloudWorkloadService = new CloudWorkloadService();
