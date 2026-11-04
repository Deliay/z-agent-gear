import { HarnessSecret } from '../models/harness-secret.js';
import type { HarnessSecrets } from '../services/secret-store.js';

/** 落库的云电脑运行期 secret（一条记录对应一个容器）。 */
export interface PersistedHarnessSecret {
  containerId: string;
  secrets: HarnessSecrets;
}

/**
 * 云电脑运行期 secret 持久化仓储（集合 `cloudcontainersecrets`）。
 *
 * 与内存 `SecretStore` 配合：写路径同时写内存与 Mongo，读路径仍走内存（性能/无 await），
 * cloud-controller 启动时把 Mongo 记录重新灌入内存。记录生命周期严格跟随容器：
 * 创建时 upsert、终态 delete；启动加载时顺带清理已不在活跃状态的孤儿记录。
 */
export interface HarnessSecretRepository {
  /** 幂等写入（同容器覆盖）。 */
  upsert(containerId: string, secrets: HarnessSecrets): Promise<void>;
  /** 删除（不存在视为成功）。 */
  delete(containerId: string): Promise<void>;
  /** 全量读取（仅启动加载使用）。 */
  findAll(): Promise<PersistedHarnessSecret[]>;
}

interface RawHarnessSecretDoc {
  containerId: string;
  hostEndpoint: string;
  hostKey: string;
  modelApiKey: string;
  modelBaseUrl: string;
  modelIds: string;
  modelContextLengths?: string | null;
  defaultWorkspace: string;
}

function toRecord(doc: RawHarnessSecretDoc): PersistedHarnessSecret {
  return {
    containerId: doc.containerId,
    secrets: {
      hostEndpoint: doc.hostEndpoint,
      hostKey: doc.hostKey,
      modelApiKey: doc.modelApiKey,
      modelBaseUrl: doc.modelBaseUrl,
      modelIds: doc.modelIds,
      ...(doc.modelContextLengths ? { modelContextLengths: doc.modelContextLengths } : {}),
      defaultWorkspace: doc.defaultWorkspace,
    },
  };
}

export class MongoHarnessSecretRepository implements HarnessSecretRepository {
  async upsert(containerId: string, secrets: HarnessSecrets): Promise<void> {
    await HarnessSecret.updateOne(
      { containerId },
      {
        $set: {
          containerId,
          hostEndpoint: secrets.hostEndpoint,
          hostKey: secrets.hostKey,
          modelApiKey: secrets.modelApiKey,
          modelBaseUrl: secrets.modelBaseUrl,
          modelIds: secrets.modelIds,
          modelContextLengths: secrets.modelContextLengths ?? null,
          defaultWorkspace: secrets.defaultWorkspace,
        },
      },
      { upsert: true },
    ).exec();
  }

  async delete(containerId: string): Promise<void> {
    await HarnessSecret.deleteOne({ containerId }).exec();
  }

  async findAll(): Promise<PersistedHarnessSecret[]> {
    const docs = await HarnessSecret.find().lean<RawHarnessSecretDoc[]>();
    return docs.map(toRecord);
  }
}

/** 本地/测试用内存仓储：不依赖 Mongo。 */
export class InMemoryHarnessSecretRepository implements HarnessSecretRepository {
  private readonly store = new Map<string, PersistedHarnessSecret>();
  /** 操作留痕（`upsert:<id>` / `delete:<id>`），供单测断言。 */
  readonly operations: string[] = [];

  async upsert(containerId: string, secrets: HarnessSecrets): Promise<void> {
    this.store.set(containerId, { containerId, secrets: { ...secrets } });
    this.operations.push(`upsert:${containerId}`);
  }

  async delete(containerId: string): Promise<void> {
    this.store.delete(containerId);
    this.operations.push(`delete:${containerId}`);
  }

  async findAll(): Promise<PersistedHarnessSecret[]> {
    return [...this.store.values()].map((record) => ({
      containerId: record.containerId,
      secrets: { ...record.secrets },
    }));
  }

  /** 测试断言用：读取单条（无则 null）。 */
  get(containerId: string): HarnessSecrets | null {
    const found = this.store.get(containerId);
    return found ? { ...found.secrets } : null;
  }
}
