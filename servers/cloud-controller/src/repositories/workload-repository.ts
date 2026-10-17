import mongoose from 'mongoose';
import {
  CloudWorkload,
  type WorkloadParamField,
} from '../models/cloud-workload.js';

/**
 * 与持久化解耦的工作负载实体（供 dispatcher 读取脚本、供兜底展开读取参数/依赖）。
 * `paramSchema`/`dependsOnWorkloadIds` 为可选：历史记录/旧测试夹具可能缺省，读取方按空处理。
 */
export interface CloudWorkloadEntity {
  id: string;
  name: string;
  initScript: string | null;
  postScript: string | null;
  paramSchema?: WorkloadParamField[];
  dependsOnWorkloadIds?: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface RawDoc {
  _id: unknown;
  name: string;
  initScript?: string | null;
  postScript?: string | null;
  paramSchema?: WorkloadParamField[] | null;
  dependsOnWorkloadIds?: unknown[] | null;
  createdAt: Date;
  updatedAt: Date;
}

function toEntity(doc: RawDoc): CloudWorkloadEntity {
  return {
    id: String(doc._id),
    name: doc.name,
    initScript: doc.initScript ?? null,
    postScript: doc.postScript ?? null,
    paramSchema: (doc.paramSchema ?? []).map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      options: [...(field.options ?? [])],
      defaultValue: field.defaultValue,
    })),
    dependsOnWorkloadIds: (doc.dependsOnWorkloadIds ?? []).map((value) => String(value)),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * 工作负载只读仓储：cloud-controller 侧仅用于按 `workloadIds` 读取脚本。
 */
export interface WorkloadRepository {
  /** 按给定 ID 查询（保持入参顺序，缺失项直接省略）。 */
  findByIds(ids: string[]): Promise<CloudWorkloadEntity[]>;
  findById(id: string): Promise<CloudWorkloadEntity | null>;
}

export class MongoWorkloadRepository implements WorkloadRepository {
  async findByIds(ids: string[]): Promise<CloudWorkloadEntity[]> {
    const validIds = ids.filter((id) => mongoose.isValidObjectId(id));
    if (validIds.length === 0) return [];
    const docs = await CloudWorkload.find({ _id: { $in: validIds } }).lean<RawDoc[]>();
    const byId = new Map(docs.map((doc) => [String(doc._id), toEntity(doc)]));
    return ids
      .map((id) => byId.get(id))
      .filter((entity): entity is CloudWorkloadEntity => entity !== undefined);
  }

  async findById(id: string): Promise<CloudWorkloadEntity | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await CloudWorkload.findById(id).lean<RawDoc | null>();
    return doc ? toEntity(doc) : null;
  }
}

/**
 * 本地/测试用内存仓储：不依赖 Mongo。
 */
export class InMemoryWorkloadRepository implements WorkloadRepository {
  private readonly store = new Map<string, CloudWorkloadEntity>();

  constructor(initial: CloudWorkloadEntity[] = []) {
    for (const workload of initial) {
      this.store.set(workload.id, { ...workload });
    }
  }

  add(workload: CloudWorkloadEntity): CloudWorkloadEntity {
    this.store.set(workload.id, { ...workload });
    return { ...workload };
  }

  async findByIds(ids: string[]): Promise<CloudWorkloadEntity[]> {
    return ids
      .map((id) => this.store.get(id))
      .filter((entity): entity is CloudWorkloadEntity => entity !== undefined)
      .map((entity) => ({ ...entity }));
  }

  async findById(id: string): Promise<CloudWorkloadEntity | null> {
    const found = this.store.get(id);
    return found ? { ...found } : null;
  }
}
