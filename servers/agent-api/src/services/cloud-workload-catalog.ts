import { CloudWorkload } from '../models/cloud-workload.js';

export interface WorkloadParamField {
  key: string;
  label: string;
  type: string;
  options?: string[];
  defaultValue: unknown;
}

export interface CloudWorkloadCatalogItem {
  id: string;
  name: string;
  paramSchema: WorkloadParamField[];
  dependsOnWorkloadIds: string[];
  isPreset: boolean;
  workloadKind: string;
  /** harness 类型（opencode / kimi_code / deepseek_harness）；standard 为 null。 */
  harnessType?: string | null;
  initScript: string | null;
}

/**
 * `cloudworkloads` 只读目录（写方 admin-api）：runtime 安装与 Github 预制项查询。
 */
export class CloudWorkloadCatalog {
  /** 全量目录（standard + harness）：设置-工作负载与 MCP `workload_list` 使用。 */
  async listAll(): Promise<CloudWorkloadCatalogItem[]> {
    const docs = await CloudWorkload.find({}).lean();
    return docs.map((doc) => this.map(doc as Record<string, unknown>));
  }

  /** 仅 standard 目录：创建云电脑时的「预装工作负载」勾选使用（harness 走 `harnessTypes`）。 */
  async listStandard(): Promise<CloudWorkloadCatalogItem[]> {
    const docs = await CloudWorkload.find({ workloadKind: 'standard' }).lean();
    return docs.map((doc) => this.map(doc as Record<string, unknown>));
  }

  async findById(id: string): Promise<CloudWorkloadCatalogItem | null> {
    const doc = await CloudWorkload.findById(id).lean();
    return doc ? this.map(doc as Record<string, unknown>) : null;
  }

  async findByPresetKey(presetKey: string): Promise<CloudWorkloadCatalogItem | null> {
    const doc = await CloudWorkload.findOne({ presetKey }).lean();
    return doc ? this.map(doc as Record<string, unknown>) : null;
  }

  async findGithubPreset(): Promise<CloudWorkloadCatalogItem | null> {
    return this.findByPresetKey('github');
  }

  private map(doc: Record<string, unknown>): CloudWorkloadCatalogItem {
    return {
      id: String(doc._id),
      name: String(doc.name ?? ''),
      paramSchema: Array.isArray(doc.paramSchema)
        ? (doc.paramSchema as WorkloadParamField[])
        : [],
      dependsOnWorkloadIds: Array.isArray(doc.dependsOnWorkloadIds)
        ? (doc.dependsOnWorkloadIds as unknown[]).map((value) => String(value))
        : [],
      isPreset: doc.isPreset === true,
      workloadKind: String(doc.workloadKind ?? 'standard'),
      harnessType: typeof doc.harnessType === 'string' && doc.harnessType ? doc.harnessType : null,
      initScript: typeof doc.initScript === 'string' ? doc.initScript : null,
    };
  }
}

export const cloudWorkloadCatalog = new CloudWorkloadCatalog();
