import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {
  CloudContainer,
  type CloudContainerPurpose,
  type CloudContainerStatus,
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
  createdAt: Date;
  updatedAt: Date;
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
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
    };
    this.store.set(entity.id, entity);
    this.operations.push(`create:${entity.status}`);
    return { ...entity };
  }

  async findById(id: string): Promise<CloudContainerEntity | null> {
    const found = this.store.get(id);
    return found ? { ...found } : null;
  }

  async findByName(name: string): Promise<CloudContainerEntity | null> {
    for (const entity of this.store.values()) {
      if (entity.name === name) return { ...entity };
    }
    return null;
  }

  async findAll(): Promise<CloudContainerEntity[]> {
    return [...this.store.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((e) => ({ ...e }));
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
      updatedAt: patch.updatedAt ?? new Date(),
    };
    this.store.set(id, updated);
    this.operations.push(`update:${updated.status}`);
    return { ...updated };
  }
}
