import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {
  CloudWorkloadLog,
  isTerminalWorkloadLogStatus,
  type WorkloadLogPhase,
  type WorkloadLogStatus,
} from '../models/cloud-workload-log.js';

/**
 * 与持久化解耦的工作负载执行日志实体。
 */
export interface CloudWorkloadLogEntity {
  id: string;
  containerId: string;
  workloadId: string;
  workloadName: string;
  phase: WorkloadLogPhase;
  status: WorkloadLogStatus;
  script: string;
  params: Record<string, unknown>;
  /** 本次启动该项是否为「必须」；历史记录缺省 false。 */
  required: boolean;
  /** 触发来源：start / runtime；历史记录缺省 start。 */
  trigger: 'start' | 'runtime';
  /** 调用来源：admin/user/mcp/system；历史记录缺省 admin。 */
  source: 'admin' | 'user' | 'mcp' | 'system';
  exitCode: number | null;
  log: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWorkloadLogInput {
  containerId: string;
  workloadId: string;
  workloadName: string;
  phase: WorkloadLogPhase;
  status: WorkloadLogStatus;
  script?: string;
  params?: Record<string, unknown>;
  /** 本次启动该项是否为「必须」；缺省 false。 */
  required?: boolean;
  /** 触发来源；缺省 start。 */
  trigger?: 'start' | 'runtime';
  /** 调用来源；缺省 admin。 */
  source?: 'admin' | 'user' | 'mcp' | 'system';
  exitCode?: number | null;
  log?: string;
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

export type UpdateWorkloadLogInput = Partial<
  Omit<CloudWorkloadLogEntity, 'id' | 'containerId' | 'createdAt'>
>;

interface RawDoc {
  _id: unknown;
  containerId: unknown;
  workloadId: unknown;
  workloadName: string;
  phase: WorkloadLogPhase;
  status: WorkloadLogStatus;
  script?: string | null;
  params?: Record<string, unknown> | null;
  required?: boolean | null;
  trigger?: string | null;
  source?: string | null;
  exitCode?: number | null;
  log?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 参数快照归一：非对象/缺省一律 `{}`（历史记录兼容，契约 A.6）。 */
function normalizeParams(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

function toEntity(doc: RawDoc): CloudWorkloadLogEntity {
  return {
    id: String(doc._id),
    containerId: String(doc.containerId),
    workloadId: String(doc.workloadId),
    workloadName: doc.workloadName,
    phase: doc.phase,
    status: doc.status,
    script: doc.script ?? '',
    params: normalizeParams(doc.params),
    required: doc.required === true,
    trigger: doc.trigger === 'runtime' ? 'runtime' : 'start',
    source:
      doc.source === 'user' || doc.source === 'mcp' || doc.source === 'system'
        ? doc.source
        : 'admin',
    exitCode: doc.exitCode ?? null,
    log: doc.log ?? '',
    startedAt: doc.startedAt ?? null,
    finishedAt: doc.finishedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * 工作负载执行日志仓储：批量创建 + 单条更新 + 按容器查询。
 * 查询一律按 `createdAt` 升序（= 执行顺序），`_id` 兜底同一毫秒内的插入序。
 */
export interface WorkloadLogRepository {
  createMany(inputs: CreateWorkloadLogInput[]): Promise<CloudWorkloadLogEntity[]>;
  updateById(id: string, patch: UpdateWorkloadLogInput): Promise<CloudWorkloadLogEntity | null>;
  findById(id: string): Promise<CloudWorkloadLogEntity | null>;
  findByContainer(containerId: string): Promise<CloudWorkloadLogEntity[]>;
  /** 未进入终态（pending/running）的记录；可限定阶段。 */
  findActiveByContainer(
    containerId: string,
    phase?: WorkloadLogPhase,
  ): Promise<CloudWorkloadLogEntity[]>;
}

export class MongoWorkloadLogRepository implements WorkloadLogRepository {
  async createMany(inputs: CreateWorkloadLogInput[]): Promise<CloudWorkloadLogEntity[]> {
    if (inputs.length === 0) return [];
    const base = Date.now();
    const docs = inputs.map((input, index) => {
      // 显式写入递增的 createdAt/updatedAt：Mongoose timestamps 在同一次 insertMany 中
      // 会给出相同时间，导致「按 createdAt 排序」无法稳定还原执行顺序。
      const at = new Date(base + index);
      return {
        containerId: input.containerId,
        workloadId: input.workloadId,
        workloadName: input.workloadName,
        phase: input.phase,
        status: input.status,
        script: input.script ?? '',
        params: normalizeParams(input.params),
        required: input.required === true,
        trigger: input.trigger ?? 'start',
        source: input.source ?? 'admin',
        exitCode: input.exitCode ?? null,
        log: input.log ?? '',
        startedAt: input.startedAt ?? null,
        finishedAt: input.finishedAt ?? null,
        createdAt: at,
        updatedAt: at,
      };
    });
    const created = await CloudWorkloadLog.insertMany(docs, { timestamps: false });
    return created.map((doc) => toEntity(doc.toObject() as unknown as RawDoc));
  }

  async updateById(
    id: string,
    patch: UpdateWorkloadLogInput,
  ): Promise<CloudWorkloadLogEntity | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await CloudWorkloadLog.findByIdAndUpdate(
      id,
      { $set: patch },
      { returnDocument: 'after' },
    ).lean<RawDoc | null>();
    return doc ? toEntity(doc) : null;
  }

  async findById(id: string): Promise<CloudWorkloadLogEntity | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await CloudWorkloadLog.findById(id).lean<RawDoc | null>();
    return doc ? toEntity(doc) : null;
  }

  async findByContainer(containerId: string): Promise<CloudWorkloadLogEntity[]> {
    if (!mongoose.isValidObjectId(containerId)) return [];
    const docs = await CloudWorkloadLog.find({ containerId })
      .sort({ createdAt: 1, _id: 1 })
      .lean<RawDoc[]>();
    return docs.map(toEntity);
  }

  async findActiveByContainer(
    containerId: string,
    phase?: WorkloadLogPhase,
  ): Promise<CloudWorkloadLogEntity[]> {
    if (!mongoose.isValidObjectId(containerId)) return [];
    const filter: Record<string, unknown> = { containerId, status: { $in: ['pending', 'running'] } };
    if (phase) filter.phase = phase;
    const docs = await CloudWorkloadLog.find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .lean<RawDoc[]>();
    return docs.map(toEntity);
  }
}

/**
 * 本地/测试用内存仓储：不依赖 Mongo。
 */
export class InMemoryWorkloadLogRepository implements WorkloadLogRepository {
  private readonly store = new Map<string, CloudWorkloadLogEntity>();
  private stamp = Date.now();

  async createMany(inputs: CreateWorkloadLogInput[]): Promise<CloudWorkloadLogEntity[]> {
    const created: CloudWorkloadLogEntity[] = [];
    for (const input of inputs) {
      const at = new Date(this.stamp);
      this.stamp += 1;
      const entity: CloudWorkloadLogEntity = {
        id: crypto.randomUUID(),
        containerId: input.containerId,
        workloadId: input.workloadId,
        workloadName: input.workloadName,
        phase: input.phase,
        status: input.status,
        script: input.script ?? '',
        params: normalizeParams(input.params),
        required: input.required === true,
        trigger: input.trigger ?? 'start',
        source: input.source ?? 'admin',
        exitCode: input.exitCode ?? null,
        log: input.log ?? '',
        startedAt: input.startedAt ?? null,
        finishedAt: input.finishedAt ?? null,
        createdAt: at,
        updatedAt: at,
      };
      this.store.set(entity.id, entity);
      created.push({ ...entity });
    }
    return created;
  }

  async updateById(
    id: string,
    patch: UpdateWorkloadLogInput,
  ): Promise<CloudWorkloadLogEntity | null> {
    const found = this.store.get(id);
    if (!found) return null;
    const updated: CloudWorkloadLogEntity = {
      ...found,
      ...patch,
      id: found.id,
      containerId: found.containerId,
      updatedAt: new Date(),
    };
    this.store.set(id, updated);
    return { ...updated };
  }

  async findById(id: string): Promise<CloudWorkloadLogEntity | null> {
    const found = this.store.get(id);
    return found ? { ...found } : null;
  }

  private sorted(): CloudWorkloadLogEntity[] {
    return [...this.store.values()]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((entity) => ({ ...entity }));
  }

  async findByContainer(containerId: string): Promise<CloudWorkloadLogEntity[]> {
    return this.sorted().filter((entity) => entity.containerId === containerId);
  }

  async findActiveByContainer(
    containerId: string,
    phase?: WorkloadLogPhase,
  ): Promise<CloudWorkloadLogEntity[]> {
    return this.sorted().filter(
      (entity) =>
        entity.containerId === containerId &&
        !isTerminalWorkloadLogStatus(entity.status) &&
        (phase === undefined || entity.phase === phase),
    );
  }
}
