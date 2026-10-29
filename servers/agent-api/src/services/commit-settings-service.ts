import mongoose from 'mongoose';
import {
  COMMITTER_MODES,
  COMMITTER_TYPES,
  UserCommitSetting,
  type CommitterMode,
  type CommitterType,
} from '../models/user-commit-setting.js';
import { GitHubAccount } from '../models/github-account.js';
import { CloudHost } from '../models/cloud-host.js';
import { CloudHostGithubBinding } from '../models/cloud-host-github-binding.js';
import { CloudContainer } from '../models/cloud-container.js';
import { Workspace } from '../models/workspace.js';
import { githubService, type AppBotIdentity } from './github.js';
import { getWorkspaceContext, WORKSPACE_READ_ONLY_MESSAGE } from './workspace-context.js';

export type CommitSettingsSource = 'WORKSPACE' | 'GLOBAL' | 'UNSET';

/** GraphQL 输入（大写枚举）；兼容外部调用直接传小写字面量。 */
export interface CommitSettingsInput {
  committerMode: string;
  committerType: string;
  githubAccountId?: string | null;
  customName?: string | null;
  customEmail?: string | null;
}

/** GraphQL 输出（大写枚举）+ 来源/只读（多租户二期）。 */
export interface CommitSettingsView {
  committerMode: Uppercase<CommitterMode>;
  committerType: Uppercase<CommitterType>;
  githubAccountId: string | null;
  customName: string | null;
  customEmail: string | null;
  source: CommitSettingsSource;
  readOnly: boolean;
}

/** 内部端点响应（裁决 4：unset 时仅返回 mode，不返回 null 字段）。 */
export type CommitIdentityResponse =
  | { mode: 'unset' }
  | { mode: 'agent_only' | 'human_only'; name: string; email: string }
  | {
      mode: 'co_author';
      name: string;
      email: string;
      coAuthorName: string;
      coAuthorEmail: string;
    };

export const COMMIT_SETTINGS_ERRORS = {
  committerRequired: 'committer is required for the selected mode',
  invalidGithubAccount: 'invalid github account',
  invalidCustomCommitter: 'invalid custom committer',
} as const;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CUSTOM_NAME_MAX = 100;
const CUSTOM_EMAIL_MAX = 254;

function toDbMode(value: unknown): CommitterMode | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  return (COMMITTER_MODES as readonly string[]).includes(lower) ? (lower as CommitterMode) : null;
}

function toDbType(value: unknown): CommitterType | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  return (COMMITTER_TYPES as readonly string[]).includes(lower)
    ? (lower as CommitterType)
    : null;
}

/** 与服务端同源的自定义提交人校验（裁决 2）。 */
export function isValidCustomCommitter(
  name: unknown,
  email: unknown,
): { ok: true; name: string; email: string } | { ok: false } {
  if (typeof name !== 'string' || typeof email !== 'string') return { ok: false };
  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  if (!trimmedName || trimmedName.length > CUSTOM_NAME_MAX) return { ok: false };
  if (/[\n\r\0]/.test(name)) return { ok: false };
  if (!trimmedEmail || trimmedEmail.length > CUSTOM_EMAIL_MAX) return { ok: false };
  if (!EMAIL_PATTERN.test(trimmedEmail)) return { ok: false };
  return { ok: true, name: trimmedName, email: trimmedEmail };
}

interface SettingShape {
  committerMode?: string;
  committerType?: string;
  githubAccountId?: unknown;
  customName?: string | null;
  customEmail?: string | null;
}

function toView(
  setting: SettingShape | null | undefined,
  source: CommitSettingsSource = 'UNSET',
  readOnly = false,
): CommitSettingsView {
  const mode = toDbMode(setting?.committerMode) ?? 'unset';
  const type = toDbType(setting?.committerType) ?? 'unset';
  return {
    committerMode: mode.toUpperCase() as Uppercase<CommitterMode>,
    committerType: type.toUpperCase() as Uppercase<CommitterType>,
    githubAccountId:
      type === 'github_account' && setting?.githubAccountId
        ? String(setting.githubAccountId)
        : null,
    customName: type === 'custom' ? (setting?.customName ?? null) : null,
    customEmail: type === 'custom' ? (setting?.customEmail ?? null) : null,
    source,
    readOnly,
  };
}

interface NormalizedSetting {
  committerMode: CommitterMode;
  committerType: CommitterType;
  githubAccountId: mongoose.Types.ObjectId | null;
  customName: string | null;
  customEmail: string | null;
}

/**
 * 用户级 Commit 设置 CRUD + 服务端权威校验 + 云容器提交身份解析。
 *
 * 校验白名单文案（前端原样映射，裁决 3）：
 * - `committer is required for the selected mode`
 * - `invalid github account`
 * - `invalid custom committer`
 *
 * 归一规则仅按 `committerType`（裁决 1）：`committerMode=UNSET` 不清空提交人字段。
 */
export class CommitSettingsService {
  /**
   * 当前工作区生效设置（三段继承：本工作区 → 本租户全局工作区 → unset）。
   * 无请求上下文（内部链路）时回退个人全局工作区，与一期等价。
   */
  async getCommitSettings(userId: string): Promise<CommitSettingsView> {
    const context = getWorkspaceContext();
    if (!context) {
      const setting = await UserCommitSetting.findOne({ userId }).lean();
      return toView(setting as SettingShape | null, setting ? 'WORKSPACE' : 'UNSET', false);
    }
    const own = await UserCommitSetting.findOne({ workspaceId: context.id }).lean();
    if (own) return toView(own as SettingShape, 'WORKSPACE', context.readOnly);
    if (context.id !== context.globalWorkspaceId && context.globalWorkspaceId) {
      const global = await UserCommitSetting.findOne({ workspaceId: context.globalWorkspaceId }).lean();
      if (global) return toView(global as SettingShape, 'GLOBAL', context.readOnly);
    }
    return toView(null, 'UNSET', context.readOnly);
  }

  async updateCommitSettings(
    userId: string,
    input: CommitSettingsInput,
  ): Promise<CommitSettingsView> {
    const context = getWorkspaceContext();
    if (context?.readOnly) throw new Error(WORKSPACE_READ_ONLY_MESSAGE);
    const normalized = await this.validateAndNormalize(userId, input);
    const workspaceId = context?.id;
    const tenantId = context?.tenantId ?? workspaceId ?? userId;
    const fields = {
      committerMode: normalized.committerMode,
      committerType: normalized.committerType,
      githubAccountId: normalized.githubAccountId,
      customName: normalized.customName,
      customEmail: normalized.customEmail,
    };
    const saved = await UserCommitSetting.findOneAndUpdate(
      workspaceId ? { workspaceId } : { userId },
      {
        $set: workspaceId
          ? {
              // userId 保留为最近编辑者（审计）；tenantId 为工作区所属租户
              userId,
              tenantId,
              workspaceId,
              ...fields,
            }
          : fields,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
      .lean()
      .catch(async (err: { code?: number }) => {
        // 并发 upsert 撞 {workspaceId} 唯一索引：回读既同行，避免竞态 500
        if (err?.code !== 11000 || !workspaceId) throw err;
        return UserCommitSetting.findOne({ workspaceId }).lean();
      });
    return toView(saved as SettingShape | null, 'WORKSPACE', false);
  }

  /**
   * 权威解析云容器最终提交身份（提案 §3.2 五步）。
   *
   * 任何无法下发有效身份的场景（主机缺失 / 未保存 / 解绑 / 越权 / 非法 / 门控未命中 /
   * bot 解析失败）一律返回 `{ mode: 'unset' }`，永不抛错、永不 404。
   */
  async resolveCommitIdentity(controllerId: string): Promise<CommitIdentityResponse> {
    if (!mongoose.isValidObjectId(controllerId)) return { mode: 'unset' };

    const host = await CloudHost.findOne({ controllerId, deletedAt: null }).lean();
    if (!host) return { mode: 'unset' };

    const userId = String(host.userId);
    const workspaceId = host.resourceWorkspaceId ? String(host.resourceWorkspaceId) : '';
    const setting = await this.resolveEffectiveSetting(userId, workspaceId);
    if (!setting) return { mode: 'unset' };

    const mode = toDbMode((setting as SettingShape).committerMode) ?? 'unset';
    if (mode === 'unset') return { mode: 'unset' };

    // 仅Agent：身份 = bot，不依赖用户提交人字段（校验层允许 agent_only + UNSET 提交人）。
    if (mode === 'agent_only') {
      if (!(await this.hasGithubWorkload(String(host._id), controllerId, userId))) {
        return { mode: 'unset' };
      }
      const bot = await this.resolveBotIdentity(controllerId);
      if (!bot) return { mode: 'unset' };
      return { mode: 'agent_only', name: bot.name, email: bot.email };
    }

    const committer = await this.resolveCommitter(userId, setting as SettingShape, workspaceId);
    if (!committer) return { mode: 'unset' };

    if (mode === 'human_only') {
      return { mode: 'human_only', name: committer.name, email: committer.email };
    }

    if (mode === 'co_author') {
      const bot = await this.resolveBotIdentity(controllerId);
      if (!bot) return { mode: 'unset' };
      return {
        mode: 'co_author',
        name: committer.name,
        email: committer.email,
        coAuthorName: bot.name,
        coAuthorEmail: bot.email,
      };
    }

    return { mode: 'unset' };
  }

  /**
   * 三段继承：本工作区设置 → 本租户全局工作区设置 → 无。
   * 云电脑缺租户工作区（升级前存量）时回退按 userId 的历史行，保证行为与升级前一致。
   */
  private async resolveEffectiveSetting(
    userId: string,
    workspaceId: string,
  ): Promise<SettingShape | null> {
    if (!workspaceId) {
      const legacy = await UserCommitSetting.findOne({ userId }).lean();
      return (legacy as SettingShape | null) ?? null;
    }
    const own = await UserCommitSetting.findOne({ workspaceId }).lean();
    if (own) return own as SettingShape;
    if (!mongoose.isValidObjectId(workspaceId)) return null;
    const workspace = await Workspace.findById(workspaceId).select('tenantId type').lean();
    if (!workspace) return null;
    if (workspace.type === 'global') return null;
    const global = await Workspace.findOne({ tenantId: workspace.tenantId, type: 'global' })
      .select('_id')
      .lean();
    if (!global) return null;
    const inherited = await UserCommitSetting.findOne({ workspaceId: String(global._id) }).lean();
    return (inherited as SettingShape | null) ?? null;
  }

  /** bot 身份解析失败按 unset 告警降级（下个周期重试，不阻断其余链路）。 */
  private async resolveBotIdentity(controllerId: string): Promise<AppBotIdentity | null> {
    const bot = await githubService.resolveAppBotIdentity();
    if (!bot) {
      console.warn(
        `[CommitSettings] bot identity unavailable, falling back to unset (controller=${controllerId})`,
      );
      return null;
    }
    return bot;
  }

  private async validateAndNormalize(
    userId: string,
    input: CommitSettingsInput,
  ): Promise<NormalizedSetting> {
    const mode = toDbMode(input?.committerMode);
    const type = toDbType(input?.committerType);
    if (!mode || !type) throw new Error('invalid commit settings');

    if ((mode === 'co_author' || mode === 'human_only') && type === 'unset') {
      throw new Error(COMMIT_SETTINGS_ERRORS.committerRequired);
    }

    if (type === 'unset') {
      return {
        committerMode: mode,
        committerType: type,
        githubAccountId: null,
        customName: null,
        customEmail: null,
      };
    }

    if (type === 'github_account') {
      const accountId = typeof input.githubAccountId === 'string' ? input.githubAccountId.trim() : '';
      if (!accountId || !mongoose.isValidObjectId(accountId)) {
        throw new Error(COMMIT_SETTINGS_ERRORS.invalidGithubAccount);
      }
      // 多租户二期（阻断-B）：候选列表 = 当前工作区 ∪ 本租户全局工作区，校验必须与
      // resolveCommitter 的共享读口径一致；无上下文（内部链路）保持创建者口径。
      const context = getWorkspaceContext();
      let account;
      if (context) {
        account = await GitHubAccount.findById(accountId).lean();
        if (account) {
          const accountWorkspace = account.workspaceId ? String(account.workspaceId) : '';
          const allowed =
            accountWorkspace === context.id ||
            (context.globalWorkspaceId !== '' && accountWorkspace === context.globalWorkspaceId) ||
            (!accountWorkspace && String(account.userId) === userId);
          if (!allowed) account = null;
        }
      } else {
        account = await GitHubAccount.findOne({ _id: accountId, userId }).lean();
      }
      if (!account) throw new Error(COMMIT_SETTINGS_ERRORS.invalidGithubAccount);
      return {
        committerMode: mode,
        committerType: type,
        githubAccountId: new mongoose.Types.ObjectId(accountId),
        customName: null,
        customEmail: null,
      };
    }

    const custom = isValidCustomCommitter(input.customName, input.customEmail);
    if (!custom.ok) throw new Error(COMMIT_SETTINGS_ERRORS.invalidCustomCommitter);
    return {
      committerMode: mode,
      committerType: type,
      githubAccountId: null,
      customName: custom.name,
      customEmail: custom.email,
    };
  }

  /** 提交人归一校验：解绑 / 越权 / 非法一律返回 null（上层按 unset 降级）。 */
  private async resolveCommitter(
    userId: string,
    setting: SettingShape,
    workspaceId = '',
  ): Promise<{ name: string; email: string } | null> {
    const type = toDbType(setting.committerType);
    if (type === 'github_account') {
      const accountId = setting.githubAccountId ? String(setting.githubAccountId) : '';
      if (!accountId || !mongoose.isValidObjectId(accountId)) return null;
      const account = workspaceId
        ? await GitHubAccount.findById(accountId).lean()
        : await GitHubAccount.findOne({ _id: accountId, userId }).lean();
      if (!account) return null;
      // 共享读口径校验：帐号 ∈ 当前工作区 ∪ 本租户全局工作区（无上下文时回退创建者校验）
      if (workspaceId) {
        const accountWorkspace = account.workspaceId ? String(account.workspaceId) : '';
        if (accountWorkspace && accountWorkspace !== workspaceId) {
          const workspace = mongoose.isValidObjectId(workspaceId)
            ? await Workspace.findById(workspaceId).select('tenantId').lean()
            : null;
          const global = workspace
            ? await Workspace.findOne({ tenantId: workspace.tenantId, type: 'global' })
                .select('_id')
                .lean()
            : null;
          if (!global || accountWorkspace !== String(global._id)) return null;
        }
      } else if (String(account.userId) !== userId) {
        return null;
      }
      const login = account.githubLogin;
      const githubUserId = account.githubUserId;
      if (typeof login !== 'string' || !login || typeof githubUserId !== 'number') return null;
      return {
        name: login,
        email: `${githubUserId}+${login}@users.noreply.github.com`,
      };
    }

    if (type === 'custom') {
      const custom = isValidCustomCommitter(setting.customName, setting.customEmail);
      if (!custom.ok) return null;
      return { name: custom.name, email: custom.email };
    }

    return null;
  }

  /**
   * `agent_only` 负载门控：存在 Github 项目绑定，或容器已安装 Github 负载
   * （创建期勾选 / runtime 安装两路证据任一命中即可）。
   */
  private async hasGithubWorkload(
    hostId: string,
    controllerId: string,
    userId: string,
  ): Promise<boolean> {
    const binding = await CloudHostGithubBinding.findOne({ controllerId, userId }).lean();
    if (binding) return true;

    const container = await CloudContainer.findOne({ hostId }).sort({ createdAt: -1 }).lean();
    const entries = Array.isArray(container?.installedWorkloads)
      ? (container!.installedWorkloads as Array<Record<string, unknown>>)
      : [];
    return entries.some((entry) => String(entry?.name ?? '').toLowerCase() === 'github');
  }
}

export const commitSettingsService = new CommitSettingsService();
