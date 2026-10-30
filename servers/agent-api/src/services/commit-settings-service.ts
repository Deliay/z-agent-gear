import {
  COMMITTER_TYPES,
  UserCommitSetting,
  type CommitterType,
} from '../models/user-commit-setting.js';
import { User } from '../models/user.js';
import { githubService } from './github.js';
import { getWorkspaceContext } from './workspace-context.js';

/** GraphQL 输入（大写枚举）；兼容外部调用直接传小写字面量。 */
export interface CommitSettingsInput {
  committerType: string;
  customName?: string | null;
  customEmail?: string | null;
}

/** GraphQL 输出（大写枚举）。 */
export interface CommitSettingsView {
  committerType: Uppercase<CommitterType>;
  customName: string | null;
  customEmail: string | null;
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
}

function toView(setting: SettingShape | null | undefined): CommitSettingsView {
  const type = toDbType(setting?.committerType) ?? 'unset';
  return {
    committerType: type.toUpperCase() as Uppercase<CommitterType>,
    customName: type === 'custom' ? (setting?.customName ?? null) : null,
    customEmail: type === 'custom' ? (setting?.customEmail ?? null) : null,
  };
}

interface NormalizedSetting {
  committerType: CommitterType;
  customName: string | null;
  customEmail: string | null;
}

/**
 * 成员级提交人设置 CRUD + Worktree 提交人解析 + 云电脑身份下发。
 *
 * - 成员独立、无共享/继承：键为 `userId`（唯一），任何工作区下均为同一份设置；
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
   */
  async resolveWorktreeCommitter(userId: string): Promise<{ name: string; email: string } | null> {
    const setting = (await UserCommitSetting.findOne({ userId }).lean()) as SettingShape | null;
    if (!setting) return null;
    if (toDbType(setting.committerType) !== 'custom') return null;
    const custom = isValidCustomCommitter(setting.customName, setting.customEmail);
    return custom.ok ? { name: custom.name, email: custom.email } : null;
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

  /** 成员所属租户（留档）：优先请求工作区上下文，其次成员归属，最后回退 userId。 */
  private async resolveTenantId(userId: string): Promise<string> {
    const context = getWorkspaceContext();
    if (context?.tenantId) return context.tenantId;
    const user = await User.findById(userId).select('tenantId').lean();
    const tenantId = (user as { tenantId?: unknown } | null)?.tenantId;
    return tenantId ? String(tenantId) : userId;
  }

  private validateAndNormalize(input: CommitSettingsInput): NormalizedSetting {
    const type = toDbType(input?.committerType);
    if (!type) throw new Error(COMMIT_SETTINGS_ERRORS.invalidCustomCommitter);

    if (type === 'unset') {
      return { committerType: 'unset', customName: null, customEmail: null };
    }

    const custom = isValidCustomCommitter(input.customName, input.customEmail);
    if (!custom.ok) throw new Error(COMMIT_SETTINGS_ERRORS.invalidCustomCommitter);
    return { committerType: 'custom', customName: custom.name, customEmail: custom.email };
  }
}

export const commitSettingsService = new CommitSettingsService();
