import mongoose from 'mongoose';
import {
  CloudStorageOperation,
  type StorageOperationStatus,
  type StorageOperationType,
} from '../models/cloud-storage-operation.js';

/** 同存储已有进行中操作（契约 409 OPERATION_RUNNING）。 */
export class OperationRunningError extends Error {
  constructor(public readonly storageId: string) {
    super(`operation is running: ${storageId}`);
    this.name = 'OperationRunningError';
  }
}

/** operationId 非法（路由层 hex24 前置校验不可达，防御分支语义为 400 INVALID_BODY）。 */
export class InvalidOperationIdError extends Error {
  constructor(public readonly operationId: string) {
    super(`invalid operation id: ${operationId}`);
    this.name = 'InvalidOperationIdError';
  }
}

export interface StorageOperationEntity {
  /** operationId（24 位 hex）。 */
  id: string;
  storageId: string;
  workspaceId: string;
  tenantId: string | null;
  type: StorageOperationType;
  status: StorageOperationStatus;
  archiveId: string | null;
  fileName: string | null;
  archivePath: string | null;
  sizeGi: number | null;
  storageClass: string | null;
  usageBytes: number | null;
  startedAt: Date;
  finishedAt: Date | null;
  failureReason: string | null;
  callbackDeliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateStorageOperationInput {
  operationId: string;
  storageId: string;
  workspaceId: string;
  tenantId?: string | null;
  type: StorageOperationType;
  archiveId?: string | null;
  fileName?: string | null;
  archivePath?: string | null;
  sizeGi?: number | null;
  storageClass?: string | null;
  startedAt?: Date;
}

export interface CompleteOperationInput {
  usageBytes?: number | null;
  finishedAt?: Date;
  failureReason?: string | null;
}

export interface StorageOperationRepository {
  /**
   * 幂等创建：同 `operationId` 重投返回既有记录（`created=false`）；
   * 同存储已有 `pending/running` 操作抛 `OperationRunningError`。
   */
  create(input: CreateStorageOperationInput): Promise<{
    created: boolean;
    operation: StorageOperationEntity;
  }>;
  findById(operationId: string, storageId?: string): Promise<StorageOperationEntity | null>;
  findInflight(storageId: string): Promise<StorageOperationEntity | null>;
  markRunning(operationId: string): Promise<StorageOperationEntity | null>;
  markSucceeded(
    operationId: string,
    input?: CompleteOperationInput,
  ): Promise<StorageOperationEntity | null>;
  markFailed(
    operationId: string,
    input?: CompleteOperationInput,
  ): Promise<StorageOperationEntity | null>;
  markCallbackDelivered(operationId: string, at?: Date): Promise<void>;
  /** `pending/running` 且 `startedAt <= now - timeoutMs`（或 `updatedAt` 兜底）。 */
  findStale(now: number, timeoutMs: number): Promise<StorageOperationEntity[]>;
  /** 全部 `pending/running`（重启后据此重跑未完成操作）。 */
  findActive(): Promise<StorageOperationEntity[]>;
  /** 终态且回调未送达（重启后重投一次，agent-api 幂等）。 */
  findUndelivered(): Promise<StorageOperationEntity[]>;
}

interface RawOperation {
  _id: unknown;
  storageId: string;
  workspaceId: string;
  tenantId?: string | null;
  type: StorageOperationType;
  status: StorageOperationStatus;
  archiveId?: string | null;
  fileName?: string | null;
  archivePath?: string | null;
  sizeGi?: number | null;
  storageClass?: string | null;
  usageBytes?: number | null;
  startedAt: Date;
  finishedAt?: Date | null;
  failureReason?: string | null;
  callbackDeliveredAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toEntity(doc: RawOperation): StorageOperationEntity {
  return {
    id: String(doc._id),
    storageId: String(doc.storageId),
    workspaceId: String(doc.workspaceId),
    tenantId: doc.tenantId ?? null,
    type: doc.type,
    status: doc.status,
    archiveId: doc.archiveId ?? null,
    fileName: doc.fileName ?? null,
    archivePath: doc.archivePath ?? null,
    sizeGi: doc.sizeGi ?? null,
    storageClass: doc.storageClass ?? null,
    usageBytes: doc.usageBytes ?? null,
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt ?? null,
    failureReason: doc.failureReason ?? null,
    callbackDeliveredAt: doc.callbackDeliveredAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number })?.code === 11000;
}

export class MongoStorageOperationRepository implements StorageOperationRepository {
  async create(
    input: CreateStorageOperationInput,
  ): Promise<{ created: boolean; operation: StorageOperationEntity }> {
    if (!mongoose.isValidObjectId(input.operationId)) {
      throw new InvalidOperationIdError(input.operationId);
    }
    const existing = await this.findById(input.operationId, input.storageId);
    if (existing) return { created: false, operation: existing };
    const inflight = await this.findInflight(input.storageId);
    if (inflight) throw new OperationRunningError(input.storageId);

    const startedAt = input.startedAt ?? new Date();
    try {
      const doc = await CloudStorageOperation.create({
        _id: new mongoose.Types.ObjectId(input.operationId),
        storageId: input.storageId,
        workspaceId: input.workspaceId,
        tenantId: input.tenantId ?? null,
        type: input.type,
        status: 'pending',
        archiveId: input.archiveId ?? null,
        fileName: input.fileName ?? null,
        archivePath: input.archivePath ?? null,
        sizeGi: input.sizeGi ?? null,
        storageClass: input.storageClass ?? null,
        startedAt,
      });
      return { created: true, operation: toEntity(doc.toObject() as unknown as RawOperation) };
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // 并发撞键：同 operationId 幂等返回；否则为同存储进行中。
      const byId = await this.findById(input.operationId, input.storageId);
      if (byId) return { created: false, operation: byId };
      throw new OperationRunningError(input.storageId);
    }
  }

  async findById(
    operationId: string,
    storageId?: string,
  ): Promise<StorageOperationEntity | null> {
    if (!mongoose.isValidObjectId(operationId)) return null;
    const filter: Record<string, unknown> = { _id: operationId };
    if (storageId) filter.storageId = storageId;
    const doc = await CloudStorageOperation.findOne(filter).lean<RawOperation | null>();
    return doc ? toEntity(doc) : null;
  }

  async findInflight(storageId: string): Promise<StorageOperationEntity | null> {
    const doc = await CloudStorageOperation.findOne({
      storageId,
      status: { $in: ['pending', 'running'] },
    })
      .sort({ createdAt: -1 })
      .lean<RawOperation | null>();
    return doc ? toEntity(doc) : null;
  }

  async markRunning(operationId: string): Promise<StorageOperationEntity | null> {
    if (!mongoose.isValidObjectId(operationId)) return null;
    const doc = await CloudStorageOperation.findOneAndUpdate(
      { _id: operationId, status: 'pending' },
      { $set: { status: 'running' } },
      { returnDocument: 'after' },
    ).lean<RawOperation | null>();
    return doc ? toEntity(doc) : null;
  }

  async markSucceeded(
    operationId: string,
    input: CompleteOperationInput = {},
  ): Promise<StorageOperationEntity | null> {
    return this.complete(operationId, 'succeeded', input);
  }

  async markFailed(
    operationId: string,
    input: CompleteOperationInput = {},
  ): Promise<StorageOperationEntity | null> {
    return this.complete(operationId, 'failed', input);
  }

  private async complete(
    operationId: string,
    status: 'succeeded' | 'failed',
    input: CompleteOperationInput,
  ): Promise<StorageOperationEntity | null> {
    if (!mongoose.isValidObjectId(operationId)) return null;
    const finishedAt = input.finishedAt ?? new Date();
    const doc = await CloudStorageOperation.findOneAndUpdate(
      { _id: operationId, status: { $in: ['pending', 'running'] } },
      {
        $set: {
          status,
          finishedAt,
          ...(input.usageBytes !== undefined ? { usageBytes: input.usageBytes } : {}),
          failureReason: status === 'failed' ? input.failureReason ?? 'operation failed' : null,
        },
      },
      { returnDocument: 'after' },
    ).lean<RawOperation | null>();
    return doc ? toEntity(doc) : null;
  }

  async markCallbackDelivered(operationId: string, at: Date = new Date()): Promise<void> {
    if (!mongoose.isValidObjectId(operationId)) return;
    await CloudStorageOperation.updateOne(
      { _id: operationId },
      { $set: { callbackDeliveredAt: at } },
    );
  }

  async findStale(now: number, timeoutMs: number): Promise<StorageOperationEntity[]> {
    const threshold = new Date(now - timeoutMs);
    const docs = await CloudStorageOperation.find({
      status: { $in: ['pending', 'running'] },
      $or: [{ startedAt: { $lte: threshold } }, { updatedAt: { $lte: threshold } }],
    })
      .limit(50)
      .lean<RawOperation[]>();
    return docs.map(toEntity);
  }

  async findUndelivered(): Promise<StorageOperationEntity[]> {
    const docs = await CloudStorageOperation.find({
      status: { $in: ['succeeded', 'failed'] },
      callbackDeliveredAt: null,
    })
      .limit(50)
      .lean<RawOperation[]>();
    return docs.map(toEntity);
  }

  async findActive(): Promise<StorageOperationEntity[]> {
    const docs = await CloudStorageOperation.find({
      status: { $in: ['pending', 'running'] },
    })
      .limit(50)
      .lean<RawOperation[]>();
    return docs.map(toEntity);
  }
}

/** 本地/测试用内存台账（单测无 Mongo）。 */
export class InMemoryStorageOperationRepository implements StorageOperationRepository {
  private readonly store = new Map<string, StorageOperationEntity>();

  async create(
    input: CreateStorageOperationInput,
  ): Promise<{ created: boolean; operation: StorageOperationEntity }> {
    if (!/^[a-f0-9]{24}$/i.test(input.operationId)) {
      throw new InvalidOperationIdError(input.operationId);
    }
    const existing = this.store.get(input.operationId);
    if (existing) return { created: false, operation: { ...existing } };
    const inflight = await this.findInflight(input.storageId);
    if (inflight) throw new OperationRunningError(input.storageId);
    const now = new Date();
    const operation: StorageOperationEntity = {
      id: input.operationId,
      storageId: input.storageId,
      workspaceId: input.workspaceId,
      tenantId: input.tenantId ?? null,
      type: input.type,
      status: 'pending',
      archiveId: input.archiveId ?? null,
      fileName: input.fileName ?? null,
      archivePath: input.archivePath ?? null,
      sizeGi: input.sizeGi ?? null,
      storageClass: input.storageClass ?? null,
      usageBytes: null,
      startedAt: input.startedAt ?? now,
      finishedAt: null,
      failureReason: null,
      callbackDeliveredAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(operation.id, operation);
    return { created: true, operation: { ...operation } };
  }

  async findById(
    operationId: string,
    storageId?: string,
  ): Promise<StorageOperationEntity | null> {
    const found = this.store.get(operationId);
    if (!found) return null;
    if (storageId && found.storageId !== storageId) return null;
    return { ...found };
  }

  async findInflight(storageId: string): Promise<StorageOperationEntity | null> {
    for (const operation of this.store.values()) {
      if (
        operation.storageId === storageId &&
        (operation.status === 'pending' || operation.status === 'running')
      ) {
        return { ...operation };
      }
    }
    return null;
  }

  async markRunning(operationId: string): Promise<StorageOperationEntity | null> {
    const found = this.store.get(operationId);
    if (!found || found.status !== 'pending') return null;
    const updated = { ...found, status: 'running' as const, updatedAt: new Date() };
    this.store.set(operationId, updated);
    return { ...updated };
  }

  async markSucceeded(
    operationId: string,
    input: CompleteOperationInput = {},
  ): Promise<StorageOperationEntity | null> {
    return this.complete(operationId, 'succeeded', input);
  }

  async markFailed(
    operationId: string,
    input: CompleteOperationInput = {},
  ): Promise<StorageOperationEntity | null> {
    return this.complete(operationId, 'failed', input);
  }

  private complete(
    operationId: string,
    status: 'succeeded' | 'failed',
    input: CompleteOperationInput,
  ): StorageOperationEntity | null {
    const found = this.store.get(operationId);
    if (!found || (found.status !== 'pending' && found.status !== 'running')) return null;
    const updated: StorageOperationEntity = {
      ...found,
      status,
      finishedAt: input.finishedAt ?? new Date(),
      usageBytes: input.usageBytes !== undefined ? input.usageBytes : found.usageBytes,
      failureReason: status === 'failed' ? input.failureReason ?? 'operation failed' : null,
      updatedAt: new Date(),
    };
    this.store.set(operationId, updated);
    return { ...updated };
  }

  async markCallbackDelivered(operationId: string, at: Date = new Date()): Promise<void> {
    const found = this.store.get(operationId);
    if (!found) return;
    this.store.set(operationId, { ...found, callbackDeliveredAt: at });
  }

  async findStale(now: number, timeoutMs: number): Promise<StorageOperationEntity[]> {
    const threshold = now - timeoutMs;
    return [...this.store.values()]
      .filter(
        (operation) =>
          (operation.status === 'pending' || operation.status === 'running') &&
          (operation.startedAt.getTime() <= threshold ||
            operation.updatedAt.getTime() <= threshold),
      )
      .map((operation) => ({ ...operation }));
  }

  async findUndelivered(): Promise<StorageOperationEntity[]> {
    return [...this.store.values()]
      .filter(
        (operation) =>
          (operation.status === 'succeeded' || operation.status === 'failed') &&
          operation.callbackDeliveredAt === null,
      )
      .map((operation) => ({ ...operation }));
  }

  async findActive(): Promise<StorageOperationEntity[]> {
    return [...this.store.values()]
      .filter(
        (operation) => operation.status === 'pending' || operation.status === 'running',
      )
      .map((operation) => ({ ...operation }));
  }
}
