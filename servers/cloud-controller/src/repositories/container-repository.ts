import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {
  CloudContainer,
  type CloudContainerPurpose,
  type CloudContainerStatus,
  type WorkloadPlanEntry,
} from '../models/cloud-container.js';

/**
 * 与持久化解耦的领域实体，供 token 校验/状态机/HTTP 序列化使用。
 */
export interface CloudContainerEntity {
  id: string;
  name: string;
  namespace: string;
  status: CloudContainerStatus;
  purpose: CloudContainerPurpose;
  refId: string | null;
  userId: string | null;
  tokenHash: string | null;
  image: string;
  connectedAt: Date | null;
  exitedAt: Date | null;
  exitReason: string | null;
  /** 启动时挂载的工作负载 ID（按选择顺序，去重）。 */
  workloadIds: string[];
  /** 本次启动最终执行计划（顺序即执行顺序）；历史容器为 []。 */
  workloadPlan: WorkloadPlanEntry[];
  /**
   * 必须工作负载失败标记（工作负载三期）：置位后容器不得被收口为 online/connecting；
   * 注销未完成时由看门狗重试强制注销。
   */
  mustFailure: boolean;
  /** 初始化中当前正在执行的工作负载脚本名称；非初始化中为 null。 */
  currentWorkloadName: string | null;
  /** 计费账户 ID；null 表示不计费（费用中心）。 */
  billingAccountId: string | null;
  /** 就绪计费起点（首次进入 online）；null 表示未就绪/不计费。 */
  billingStartedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateContainerInput {
  name: string;
  namespace: string;
  purpose: CloudContainerPurpose;
  image: string;
  refId?: string | null;
  userId?: string | null;
  status?: CloudContainerStatus;
  tokenHash?: string | null;
  connectedAt?: Date | null;
  exitedAt?: Date | null;
  exitReason?: string | null;
  workloadIds?: string[];
  workloadPlan?: WorkloadPlanEntry[];
  mustFailure?: boolean;
  currentWorkloadName?: string | null;
  billingAccountId?: string | null;
  billingStartedAt?: Date | null;
  /** 仅测试用途：显式指定时间戳，便于超时巡检确定性测试。 */
  createdAt?: Date;
  updatedAt?: Date;
}

export type UpdateContainerInput = Partial<
  Omit<CloudContainerEntity, 'id' | 'createdAt'>
>;

/**
 * 条件更新选项（乐观并发/CAS）：仅当当前状态落在 `fromStatuses` 内才执行写入，
 * 否则返回 `null`。调用方在失败时应重新读取记录，避免用陈旧状态覆写。
 */
export interface UpdateContainerOptions {
  fromStatuses?: CloudContainerStatus[];
}

export interface ContainerRepository {
  create(input: CreateContainerInput): Promise<CloudContainerEntity>;
  findById(id: string): Promise<CloudContainerEntity | null>;
  findByName(name: string): Promise<CloudContainerEntity | null>;
  findAll(): Promise<CloudContainerEntity[]>;
  update(
    id: string,
    patch: UpdateContainerInput,
    options?: UpdateContainerOptions,
  ): Promise<CloudContainerEntity | null>;
}

interface RawDoc {
  _id: unknown;
  name: string;
  namespace: string;
  status: CloudContainerStatus;
  purpose: CloudContainerPurpose;
  refId?: string | null;
  userId?: string | null;
  tokenHash?: string | null;
  image: string;
  connectedAt?: Date | null;
  exitedAt?: Date | null;
  exitReason?: string | null;
  workloadIds?: unknown[] | null;
  workloadPlan?: Array<{ workloadId: unknown; params?: unknown; implicit?: unknown; required?: unknown }> | null;
  mustFailure?: boolean | null;
  currentWorkloadName?: string | null;
  billingAccountId?: string | null;
  billingStartedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 归一化计划条目：`workloadId` 转字符串、`params` 缺省 `{}`、`implicit`/`required` 缺省 false。 */
function normalizePlanEntry(entry: {
  workloadId: unknown;
  params?: unknown;
  implicit?: unknown;
  required?: unknown;
}): WorkloadPlanEntry {
  return {
    workloadId: String(entry.workloadId),
    params:
      entry.params && typeof entry.params === 'object' && !Array.isArray(entry.params)
        ? ({ ...(entry.params as Record<string, unknown>) })
        : {},
    implicit: entry.implicit === true,
    required: entry.required === true,
  };
}

/** 深拷贝计划，避免内存仓储的调用方共享同一数组/对象引用。 */
function clonePlan(
  plan:
    | readonly { workloadId: unknown; params?: unknown; implicit?: unknown; required?: unknown }[]
    | undefined,
): WorkloadPlanEntry[] {
  return (plan ?? []).map((entry) => normalizePlanEntry(entry));
}

function toEntity(doc: RawDoc): CloudContainerEntity {
  return {
    id: String(doc._id),
    name: doc.name,
    namespace: doc.namespace,
    status: doc.status,
    purpose: doc.purpose,
    refId: doc.refId ?? null,
    userId: doc.userId ?? null,
    tokenHash: doc.tokenHash ?? null,
    image: doc.image,
    connectedAt: doc.connectedAt ?? null,
    exitedAt: doc.exitedAt ?? null,
    exitReason: doc.exitReason ?? null,
    workloadIds: (doc.workloadIds ?? []).map((value) => String(value)),
    workloadPlan: clonePlan(doc.workloadPlan ?? []),
    mustFailure: doc.mustFailure === true,
    currentWorkloadName: doc.currentWorkloadName ?? null,
    billingAccountId: doc.billingAccountId ?? null,
    billingStartedAt: doc.billingStartedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export class MongoContainerRepository implements ContainerRepository {
  async create(input: CreateContainerInput): Promise<CloudContainerEntity> {
    const doc = await CloudContainer.create({
      name: input.name,
      namespace: input.namespace,
      purpose: input.purpose,
      image: input.image,
      status: input.status ?? 'creating',
      refId: input.refId ?? null,
      userId: input.userId ?? null,
      tokenHash: input.tokenHash ?? null,
      connectedAt: input.connectedAt ?? null,
      exitedAt: input.exitedAt ?? null,
      exitReason: input.exitReason ?? null,
      workloadIds: input.workloadIds ?? [],
      workloadPlan: clonePlan(input.workloadPlan),
      mustFailure: input.mustFailure ?? false,
      currentWorkloadName: input.currentWorkloadName ?? null,
      billingAccountId: input.billingAccountId ?? null,
      billingStartedAt: input.billingStartedAt ?? null,
    });
    return toEntity(doc.toObject() as unknown as RawDoc);
  }

  async findById(id: string): Promise<CloudContainerEntity | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await CloudContainer.findById(id).lean<RawDoc | null>();
    return doc ? toEntity(doc) : null;
  }

  async findByName(name: string): Promise<CloudContainerEntity | null> {
    const doc = await CloudContainer.findOne({ name }).lean<RawDoc | null>();
    return doc ? toEntity(doc) : null;
  }

  async findAll(): Promise<CloudContainerEntity[]> {
    const docs = await CloudContainer.find().sort({ createdAt: -1 }).lean<RawDoc[]>();
    return docs.map(toEntity);
  }

  async update(
    id: string,
    patch: UpdateContainerInput,
    options?: UpdateContainerOptions,
  ): Promise<CloudContainerEntity | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const filter: Record<string, unknown> = { _id: id };
    if (options?.fromStatuses && options.fromStatuses.length > 0) {
      filter.status = { $in: options.fromStatuses };
    }
    const doc = await CloudContainer.findOneAndUpdate(
      filter,
      { $set: patch },
      { new: true },
    ).lean<RawDoc | null>();
    return doc ? toEntity(doc) : null;
  }
}

/**
 * 本地/测试用内存仓储：不依赖 Mongo，便于单测与 mock 链路。
 */
export class InMemoryContainerRepository implements ContainerRepository {
  private readonly store = new Map<string, CloudContainerEntity>();

  /** 记录操作序列（测试用于断言落库顺序）。 */
  readonly operations: string[] = [];

  async create(input: CreateContainerInput): Promise<CloudContainerEntity> {
    const now = new Date();
    const entity: CloudContainerEntity = {
      id: crypto.randomUUID(),
      name: input.name,
      namespace: input.namespace,
      status: input.status ?? 'creating',
      purpose: input.purpose,
      refId: input.refId ?? null,
      userId: input.userId ?? null,
      tokenHash: input.tokenHash ?? null,
      image: input.image,
      connectedAt: input.connectedAt ?? null,
      exitedAt: input.exitedAt ?? null,
      exitReason: input.exitReason ?? null,
      workloadIds: [...(input.workloadIds ?? [])],
      workloadPlan: clonePlan(input.workloadPlan),
      mustFailure: input.mustFailure ?? false,
      currentWorkloadName: input.currentWorkloadName ?? null,
      billingAccountId: input.billingAccountId ?? null,
      billingStartedAt: input.billingStartedAt ?? null,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
    };
    this.store.set(entity.id, entity);
    this.operations.push(`create:${entity.status}`);
    return { ...entity, workloadPlan: clonePlan(entity.workloadPlan) };
  }

  async findById(id: string): Promise<CloudContainerEntity | null> {
    const found = this.store.get(id);
    return found ? { ...found, workloadPlan: clonePlan(found.workloadPlan) } : null;
  }

  async findByName(name: string): Promise<CloudContainerEntity | null> {
    for (const entity of this.store.values()) {
      if (entity.name === name) {
        return { ...entity, workloadPlan: clonePlan(entity.workloadPlan) };
      }
    }
    return null;
  }

  async findAll(): Promise<CloudContainerEntity[]> {
    return [...this.store.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((e) => ({ ...e, workloadPlan: clonePlan(e.workloadPlan) }));
  }

  async update(
    id: string,
    patch: UpdateContainerInput,
    options?: UpdateContainerOptions,
  ): Promise<CloudContainerEntity | null> {
    const found = this.store.get(id);
    if (!found) return null;
    if (options?.fromStatuses && !options.fromStatuses.includes(found.status)) {
      return null;
    }
    const updated: CloudContainerEntity = {
      ...found,
      ...patch,
      id: found.id,
      workloadPlan: patch.workloadPlan ? clonePlan(patch.workloadPlan) : clonePlan(found.workloadPlan),
      updatedAt: patch.updatedAt ?? new Date(),
    };
    this.store.set(id, updated);
    this.operations.push(`update:${updated.status}`);
    return { ...updated, workloadPlan: clonePlan(updated.workloadPlan) };
  }
}
