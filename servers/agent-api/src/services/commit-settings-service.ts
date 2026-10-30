import {
  COMMITTER_TYPES,
  UserCommitSetting,
  type CommitterType,
} from '../models/user-commit-setting.js';
import { User } from '../models/user.js';
import { githubService } from './github.js';

/** GraphQL 输入（大写枚举）；兼容外部调用直接传小写字面量。 */
export interface CommitSettingsInput {
  committerType: string;
  customName?: string | null;
  customEmail?: string | null;
  commitWithBot?: boolean | null;
}

/** GraphQL 输出（大写枚举）。 */
export interface CommitSettingsView {
  committerType: Uppercase<CommitterType>;
  customName: string | null;
  customEmail: string | null;
  /** 仅 `committerType=custom` 时可为 true；UNSET 恒 false。 */
  commitWithBot: boolean;
}

/** Worktree 提交人（可选共同作者：平台 bot）。 */
export interface ResolvedWorktreeCommitter {
  name: string;
  email: string;
  coAuthorName?: string;
  coAuthorEmail?: string;
}

/**
 * 内部端点响应（保留 `mode` 包络以兼容 2.11.x 容器 `consume()`）。
 *
 * 云电脑自身身份**恒为 bot**：`{ mode:'agent_only', name, email }`；
 * bot 解析失败兜底 `{ mode:'unset' }`（容器不写身份）。
 */
export type CommitIdentityResponse =
  | { mode: 'unset' }
  | { mode: 'agent_only'; name: string; email: string };

export const COMMIT_SETTINGS_ERRORS = {
  invalidCustomCommitter: 'invalid custom committer',
} as const;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CUSTOM_NAME_MAX = 100;
const CUSTOM_EMAIL_MAX = 254;

function toDbType(value: unknown): CommitterType | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  return (COMMITTER_TYPES as readonly string[]).includes(lower) ? (lower as CommitterType) : null;
}

/** 与服务端同源的自定义提交人校验（自定义用户名/邮箱）。 */
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
  if (/[\n\r\0]/.test(email)) return { ok: false };
  if (!EMAIL_PATTERN.test(trimmedEmail)) return { ok: false };
  return { ok: true, name: trimmedName, email: trimmedEmail };
}

interface SettingShape {
  committerType?: string;
  customName?: string | null;
  customEmail?: string | null;
  commitWithBot?: boolean | null;
}

function toView(setting: SettingShape | null | undefined): CommitSettingsView {
  const type = toDbType(setting?.committerType) ?? 'unset';
  const isCustom = type === 'custom';
  return {
    committerType: type.toUpperCase() as Uppercase<CommitterType>,
    customName: isCustom ? (setting?.customName ?? null) : null,
    customEmail: isCustom ? (setting?.customEmail ?? null) : null,
    commitWithBot: isCustom ? setting?.commitWithBot === true : false,
  };
}

interface NormalizedSetting {
  committerType: CommitterType;
  customName: string | null;
  customEmail: string | null;
  commitWithBot: boolean;
}

/**
 * 成员级提交人设置 CRUD + Worktree 提交人解析 + 云电脑身份下发。
 *
 * - 成员独立、无共享/继承：键为 `userId`（唯一），任何工作区下均为同一份设置；
 *   读写均以 `userId` 点查、**不读取 ALS 工作区上下文**（模型不挂作用域插件）；
 *   `tenantId` 仅留档为成员归属租户（`users.tenantId`），不作业务过滤；
 * - 校验白名单仅 `invalid custom committer`：`custom` 需 trim 后 name ∈ (0,100]、
 *   email ≤254、无 `\n\r\0`、邮箱正则；`unset` 清空 custom 字段；
 * - `resolveWorktreeCommitter(userId)`：点查设置 → `custom` 且合法 → `{name,email}`，否则 null；
 * - `resolveCloudHostIdentity()`：云电脑自身恒 bot（无视个人设置）。
 */
export class CommitSettingsService {
  /** 当前成员的提交人设置（点查 `userId`，不读取工作区上下文）。 */
  async getCommitSettings(userId: string): Promise<CommitSettingsView> {
    const setting = await UserCommitSetting.findOne({ userId }).lean();
    return toView(setting as SettingShape | null);
  }

  /** 保存当前成员的提交人设置（按 `userId` upsert，无重复行）。 */
  async updateCommitSettings(
    userId: string,
    input: CommitSettingsInput,
  ): Promise<CommitSettingsView> {
    const normalized = this.validateAndNormalize(input);
    const tenantId = await this.resolveTenantId(userId);
    const saved = await UserCommitSetting.findOneAndUpdate(
      { userId },
      {
        $set: {
          userId,
          tenantId,
          committerType: normalized.committerType,
          customName: normalized.customName,
          customEmail: normalized.customEmail,
          commitWithBot: normalized.commitWithBot,
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    )
      .lean()
      .catch(async (err: { code?: number }) => {
        // 并发 upsert 撞 {userId} 唯一索引：回读既同行，避免竞态 500
        if (err?.code !== 11000) throw err;
        return UserCommitSetting.findOne({ userId }).lean();
      });
    return toView(saved as SettingShape | null);
  }

  /**
   * Worktree 提交人解析：`custom` 且校验通过 → `{name,email}`，否则 null（= 沿用容器级 bot）。
   * `commitWithBot=true` 时追加平台 bot 为共同作者；bot 解析失败降级为仅成员署名。
   */
  async resolveWorktreeCommitter(userId: string): Promise<ResolvedWorktreeCommitter | null> {
    const setting = (await UserCommitSetting.findOne({ userId }).lean()) as SettingShape | null;
    if (!setting) return null;
    if (toDbType(setting.committerType) !== 'custom') return null;
    const custom = isValidCustomCommitter(setting.customName, setting.customEmail);
    if (!custom.ok) return null;

    const committer: ResolvedWorktreeCommitter = { name: custom.name, email: custom.email };
    if (setting.commitWithBot !== true) return committer;

    const bot = await githubService.resolveAppBotIdentity();
    if (!bot) {
      console.warn('[CommitSettings] bot identity unavailable, co-author skipped');
      return committer;
    }
    return {
      ...committer,
      coAuthorName: bot.name,
      coAuthorEmail: bot.email,
    };
  }

  /**
   * 云电脑自身提交身份：**恒 bot**（无视成员个人设置）。
   *
   * bot 解析失败兜底 `{ mode:'unset' }`；保留 `mode` 包络以兼容 2.11.x 容器 `consume()`。
   */
  async resolveCloudHostIdentity(): Promise<CommitIdentityResponse> {
    const bot = await githubService.resolveAppBotIdentity();
    if (!bot) {
      console.warn('[CommitSettings] bot identity unavailable, falling back to unset');
      return { mode: 'unset' };
    }
    return { mode: 'agent_only', name: bot.name, email: bot.email };
  }

  /**
   * 成员所属租户（留档）：**恒取成员归属租户**（`users.tenantId`），
   * 不读取 ALS 工作区上下文——否则同一成员的设置在「保存时工作区租户」与「读取时工作区租户」
   * 之间被判为不同记录（与迁移 019 cleanFields 的刷新口径保持一致）。
   */
  private async resolveTenantId(userId: string): Promise<string> {
    const user = await User.findById(userId).select('tenantId').lean();
    const tenantId = (user as { tenantId?: unknown } | null)?.tenantId;
    return tenantId ? String(tenantId) : userId;
  }

  private validateAndNormalize(input: CommitSettingsInput): NormalizedSetting {
    const type = toDbType(input?.committerType);
    if (!type) throw new Error(COMMIT_SETTINGS_ERRORS.invalidCustomCommitter);

    if (type === 'unset') {
      return { committerType: 'unset', customName: null, customEmail: null, commitWithBot: false };
    }

    const custom = isValidCustomCommitter(input.customName, input.customEmail);
    if (!custom.ok) throw new Error(COMMIT_SETTINGS_ERRORS.invalidCustomCommitter);
    return {
      committerType: 'custom',
      customName: custom.name,
      customEmail: custom.email,
      commitWithBot: input.commitWithBot === true,
    };
  }
}

export const commitSettingsService = new CommitSettingsService();
