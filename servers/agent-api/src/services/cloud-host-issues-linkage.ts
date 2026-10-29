import mongoose from 'mongoose';
import { Controller } from '../models/controller.js';
import { actorFilter } from './workspace-context.js';
import { ConfiguredWorkflow } from '../models/configured-workflow.js';
import {
  CloudHostIssuesLinkage,
  dedupeRepoNames,
  LABEL_NAME_MAX_LENGTH,
  REPO_FULL_NAMES_MAX,
} from '../models/cloud-host-issues-linkage.js';
import { githubService } from './github.js';

type Doc = Record<string, unknown>;

export interface CloudHostIssuesLinkageInput {
  /** create 时必传；update 时忽略（以 id 定位） */
  controllerId: string;
  configuredWorkflowId: string;
  labelName: string;
  repoFullNames: string[];
}

export interface CloudHostIssuesLabelCleanupResult {
  deleted: string[];
  failed: string[];
}

const REPO_FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(0).toISOString();
}

function sameRepoSet(left: string[], right: string[]): boolean {
  const normalize = (values: string[]) =>
    [...new Set(values.map((value) => value.toLowerCase()))].sort().join(',');
  return normalize(left) === normalize(right);
}

/**
 * 云电脑 GitHub Issues 联动配置服务。
 *
 * 业务规则集中在此（resolver 只做参数透传与错误映射）：
 * - 控制器须为当前用户的 `type=cloud` 主机；
 * - 工作流须属于该控制器且至少含一个 HUMAN 节点；
 * - 标签名 trim 后非空、≤50、不含逗号；同控制器内大小写不敏感唯一；
 * - 仓库至少 1 个、去重后 ≤50，且均在用户 GitHub 安装授权内；
 * - create/update 落库后逐仓库同步标签，失败汇总 `label sync failed: a,b`（配置已保存）。
 */
class CloudHostIssuesLinkageService {
  async list(userId: string, controllerId: string): Promise<Doc[]> {
    await this.requireCloudController(userId, controllerId);
    const rows = await CloudHostIssuesLinkage.find({ userId, controllerId })
      .sort({ createdAt: 1 })
      .lean();
    return rows.map((row) => this.map(row as Doc));
  }

  async create(userId: string, input: CloudHostIssuesLinkageInput): Promise<Doc> {
    const controllerId = input.controllerId;
    await this.requireCloudController(userId, controllerId);
    const validated = await this.validate(userId, controllerId, input);

    // 幂等重试：同标签同工作流同仓库 = 上次同步失败后的重发，直接重同步
    const existing = await CloudHostIssuesLinkage.findOne({
      controllerId,
      labelNameLower: validated.labelName.toLowerCase(),
    }).lean();
    if (existing) {
      const sameWorkflow = String(existing.configuredWorkflowId) === validated.workflowId;
      const sameRepos = sameRepoSet(
        (existing.repoFullNames ?? []) as string[],
        validated.repoFullNames,
      );
      if (!sameWorkflow || !sameRepos) {
        throw new Error(`label name already exists: ${validated.labelName}`);
      }
      await this.syncLabels(userId, validated.repoFullNames, validated.labelName);
      return this.map({ ...existing, configuredWorkflowName: validated.workflowName });
    }

    let created: Doc;
    try {
      created = (await CloudHostIssuesLinkage.create({
        userId,
        controllerId,
        configuredWorkflowId: validated.workflowId,
        configuredWorkflowName: validated.workflowName,
        labelName: validated.labelName,
        labelNameLower: validated.labelName.toLowerCase(),
        repoFullNames: validated.repoFullNames,
      })) as unknown as Doc;
    } catch (err) {
      this.throwIfDuplicateLabel(err, validated.labelName);
      throw err;
    }

    await this.syncLabels(userId, validated.repoFullNames, validated.labelName);
    return this.map(created);
  }

  async update(userId: string, id: string, input: CloudHostIssuesLinkageInput): Promise<Doc> {
    const existing = await this.findOwned(userId, id);
    const controllerId = String(existing.controllerId);
    const validated = await this.validate(userId, controllerId, input, id);

    await CloudHostIssuesLinkage.updateOne(
      { _id: id, userId },
      {
        $set: {
          configuredWorkflowId: validated.workflowId,
          configuredWorkflowName: validated.workflowName,
          labelName: validated.labelName,
          labelNameLower: validated.labelName.toLowerCase(),
          repoFullNames: validated.repoFullNames,
        },
      },
    ).catch((err: unknown) => {
      this.throwIfDuplicateLabel(err, validated.labelName);
      throw err;
    });

    // 改名时不同步删除旧标签（旧标签保留但不再触发），仅同步新标签
    await this.syncLabels(userId, validated.repoFullNames, validated.labelName);
    const updated = await CloudHostIssuesLinkage.findOne({ _id: id, userId }).lean();
    return this.map(updated as Doc);
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const result = await CloudHostIssuesLinkage.deleteOne({ _id: id, userId });
    return (result.deletedCount ?? 0) > 0;
  }

  /** 销毁云电脑前清理标签：逐（配置标签 × 配置仓库）删除，404 视为成功；完成后删除配置行。 */
  async cleanup(userId: string, controllerId: string): Promise<CloudHostIssuesLabelCleanupResult> {
    await this.requireCloudController(userId, controllerId);
    const rows = await CloudHostIssuesLinkage.find({ userId, controllerId }).lean();
    const deleted: string[] = [];
    const failed: string[] = [];

    for (const row of rows) {
      const labelName = String(row.labelName ?? '');
      for (const repoFullName of (row.repoFullNames ?? []) as string[]) {
        const key = `${repoFullName}#${labelName}`;
        try {
          await githubService.deleteIssueLabel(userId, repoFullName, labelName);
          deleted.push(key);
        } catch {
          failed.push(key);
        }
      }
    }

    await CloudHostIssuesLinkage.deleteMany({ userId, controllerId });
    return { deleted, failed };
  }

  /** 云电脑删除级联：清空该控制器的联动配置行（失败由调用方告警，不阻断删除）。 */
  async deleteByController(controllerId: string): Promise<number> {
    const result = await CloudHostIssuesLinkage.deleteMany({ controllerId });
    return result.deletedCount ?? 0;
  }

  private async requireCloudController(userId: string, controllerId: string): Promise<void> {
    if (!mongoose.isValidObjectId(controllerId)) throw new Error('cloud host not found');
    const controller = await Controller.findOne({
      _id: controllerId,
      ...actorFilter(userId),
      type: 'cloud',
    }).lean();
    if (!controller) throw new Error('cloud host not found');
  }

  private async findOwned(userId: string, id: string): Promise<Doc> {
    if (!mongoose.isValidObjectId(id)) throw new Error('linkage not found');
    const row = await CloudHostIssuesLinkage.findOne({ _id: id, userId }).lean();
    if (!row) throw new Error('linkage not found');
    return row as Doc;
  }

  private async validate(
    userId: string,
    controllerId: string,
    input: CloudHostIssuesLinkageInput,
    excludeId?: string,
  ): Promise<{
    workflowId: string;
    workflowName: string;
    labelName: string;
    repoFullNames: string[];
  }> {
    const labelName = typeof input.labelName === 'string' ? input.labelName.trim() : '';
    if (!labelName || labelName.length > LABEL_NAME_MAX_LENGTH || labelName.includes(',')) {
      throw new Error('invalid label name');
    }

    const repoFullNames = dedupeRepoNames(input.repoFullNames ?? []);
    if (repoFullNames.length === 0) throw new Error('at least one repo is required');
    if (repoFullNames.length > REPO_FULL_NAMES_MAX) throw new Error('too many repos');
    for (const repoFullName of repoFullNames) {
      if (!REPO_FULL_NAME_PATTERN.test(repoFullName)) {
        throw new Error(`repo not authorized: ${repoFullName}`);
      }
    }

    const workflowId = String(input.configuredWorkflowId ?? '');
    const workflow = mongoose.isValidObjectId(workflowId)
      ? await ConfiguredWorkflow.findOne({ _id: workflowId, ...actorFilter(userId), controllerId }).lean()
      : null;
    const hasHuman = (workflow?.nodes ?? []).some(
      (node: { type?: string }) => node.type === 'HUMAN',
    );
    if (!workflow || !hasHuman) throw new Error('workflow must contain a human node');

    // 重复标签前置校验（唯一索引 11000 兜底走同一文案）
    const duplicate = await CloudHostIssuesLinkage.findOne({
      controllerId,
      labelNameLower: labelName.toLowerCase(),
      ...(excludeId && mongoose.isValidObjectId(excludeId) ? { _id: { $ne: excludeId } } : {}),
    }).lean();
    if (duplicate && excludeId) throw new Error(`label name already exists: ${labelName}`);

    await this.assertReposAuthorized(userId, repoFullNames);
    return {
      workflowId,
      workflowName: String(workflow.name ?? ''),
      labelName,
      repoFullNames,
    };
  }

  /** 每个仓库须在用户任一 GitHub 安装授权内（错误文案契约：`repo not authorized: <fullName>`）。 */
  private async assertReposAuthorized(userId: string, repoFullNames: string[]): Promise<void> {
    for (const repoFullName of repoFullNames) {
      await githubService.resolveRepoAccount(userId, repoFullName);
    }
  }

  /** 逐仓库同步标签；单仓库失败不中断，全部失败项汇总为 `label sync failed: a,b`。 */
  private async syncLabels(userId: string, repoFullNames: string[], labelName: string): Promise<void> {
    const failed: string[] = [];
    for (const repoFullName of repoFullNames) {
      try {
        await githubService.ensureIssueLabel(userId, repoFullName, labelName);
      } catch {
        failed.push(repoFullName);
      }
    }
    if (failed.length > 0) throw new Error(`label sync failed: ${failed.join(',')}`);
  }

  private throwIfDuplicateLabel(err: unknown, labelName: string): void {
    if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) {
      throw new Error(`label name already exists: ${labelName}`);
    }
  }

  private map(row: Doc): Doc {
    return {
      id: String(row._id ?? row.id),
      controllerId: String(row.controllerId),
      configuredWorkflowId: String(row.configuredWorkflowId),
      configuredWorkflowName: String(row.configuredWorkflowName ?? ''),
      labelName: String(row.labelName ?? ''),
      repoFullNames: (row.repoFullNames ?? []) as string[],
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }
}

export const cloudHostIssuesLinkageService = new CloudHostIssuesLinkageService();
