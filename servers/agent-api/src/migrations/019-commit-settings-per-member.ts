import mongoose from 'mongoose';
import { ensureIndex } from './index-utils.js';

export const name = '019-commit-settings-per-member';

export const BATCH_SIZE = 500;

/** 迁移后残留检查用的键（幂等门禁）。 */
export const LEGACY_COMMITTER_TYPE = 'github_account';

type Collection = ReturnType<typeof mongoose.connection.collection>;

export interface ConvertResult {
  /** github_account → custom 等价转换行数 */
  converted: number;
  /** 帐号缺失/取值失败 → unset 的行数 */
  unsetFromMissingAccount: number;
}

export interface RekeyResult {
  /** 归属重键（userId 被改写）行数 */
  rekeyed: number;
  /** 同 owner 碰撞被删除的冗余行数 */
  merged: number;
}

export interface CleanResult {
  /** 字段清洗行数 */
  cleaned: number;
}

function toObjectId(value: unknown): mongoose.Types.ObjectId | null {
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (typeof value === 'string' && mongoose.isValidObjectId(value)) {
    return new mongoose.Types.ObjectId(value);
  }
  return null;
}

function noreplyEmail(githubUserId: number, login: string): string {
  return `${githubUserId}+${login}@users.noreply.github.com`;
}

/**
 * 步骤 1：`github_account` → `custom` 等价转换。
 *
 * 署名与旧 `resolveCommitter` 的生效值逐字一致（`login` + `<githubUserId>+<login>@users.noreply.github.com`）；
 * 帐号缺失或取值非法 → `unset` 并清空自定义字段。
 */
export async function convertGithubAccounts(): Promise<ConvertResult> {
  const settings = mongoose.connection.collection('user_commit_settings');
  const accounts = mongoose.connection.collection('githubaccounts');

  const rows = await settings
    .find({ committerType: LEGACY_COMMITTER_TYPE })
    .toArray();

  let converted = 0;
  let unsetFromMissingAccount = 0;

  for (const row of rows) {
    const accountId = toObjectId(row.githubAccountId);
    const account = accountId ? await accounts.findOne({ _id: accountId }) : null;
    const login = account && typeof account.githubLogin === 'string' ? account.githubLogin : '';
    const githubUserId = account?.githubUserId;

    if (login && typeof githubUserId === 'number') {
      await settings.updateOne(
        { _id: row._id },
        {
          $set: {
            committerType: 'custom',
            customName: login,
            customEmail: noreplyEmail(githubUserId, login),
          },
          $unset: { githubAccountId: '' },
        },
      );
      converted += 1;
    } else {
      await settings.updateOne(
        { _id: row._id },
        {
          $set: { committerType: 'unset', customName: null, customEmail: null },
          $unset: { githubAccountId: '' },
        },
      );
      unsetFromMissingAccount += 1;
    }
  }

  return { converted, unsetFromMissingAccount };
}

/** 解析每一行的归属 owner：行 → workspace → tenant。 */
async function resolveOwner(row: Record<string, unknown>): Promise<string> {
  const fallbackOwner = row.userId ? String(row.userId) : '';
  const workspaceId = toObjectId(row.workspaceId);
  // workspaceId 为空的旧式行 owner 不变
  if (!workspaceId) return fallbackOwner;

  const workspace = await mongoose.connection
    .collection('workspaces')
    .findOne({ _id: workspaceId }, { projection: { tenantId: 1 } });
  if (!workspace) return fallbackOwner;

  const tenantId = workspace.tenantId ? String(workspace.tenantId) : '';
  if (!tenantId) return fallbackOwner;
  const tenant = await mongoose.connection
    .collection('tenants')
    .findOne({ _id: toObjectId(tenantId) ?? tenantId }, { projection: { type: 1 } });

  // personal 租户 `_id` 复用 owner userId，故 owner = tenantId
  if (tenant?.type === 'personal') return tenantId;
  // team 租户 → 行内 userId（最近编辑人）；未知租户类型保守沿用行内 userId
  return fallbackOwner;
}

function pickKeeper(rows: Array<Record<string, unknown>>): Record<string, unknown> {
  const sorted = [...rows].sort((a, b) => {
    const aUnset = a.committerType === 'unset' ? 1 : 0;
    const bUnset = b.committerType === 'unset' ? 1 : 0;
    if (aUnset !== bUnset) return aUnset - bUnset; // 非 unset 优先
    const at = a.updatedAt instanceof Date ? a.updatedAt.getTime() : 0;
    const bt = b.updatedAt instanceof Date ? b.updatedAt.getTime() : 0;
    return bt - at; // updatedAt 最新优先
  });
  return sorted[0];
}

/**
 * 步骤 2：归属重键（`workspaceId` 键 → `userId` 键）。
 *
 * - 所属租户 `type='personal'` → owner = 工作区 tenantId（= 个人 owner userId）；
 * - 所属租户 `type='team'` → owner = 行内 `userId`（最近编辑人）；
 * - `workspaceId` 为空的旧式行 owner 不变；
 * - 同 owner 多行碰撞 → 保留最新非 unset 行，其余删除并计数。
 */
export async function rekeyOwners(): Promise<RekeyResult> {
  const settings = mongoose.connection.collection('user_commit_settings');
  const rows = await settings.find({}).toArray();

  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const owner = await resolveOwner(row as Record<string, unknown>);
    if (!owner) continue;
    const list = groups.get(owner) ?? [];
    list.push(row as Record<string, unknown>);
    groups.set(owner, list);
  }

  let rekeyed = 0;
  let merged = 0;

  for (const [owner, group] of groups) {
    const keeper = pickKeeper(group);
    const keeperObjectId = toObjectId(keeper._id);
    if (!keeperObjectId) continue;
    const keeperId = String(keeper._id);
    if (String(keeper.userId ?? '') !== owner) rekeyed += 1;
    // 注意：此处只改写 userId，不清理 workspaceId —— 旧唯一索引 `uniq_workspace_commit_setting`
    // 仍存在，多行同时置空会撞唯一键；workspaceId 的清除在索引「先建后删」之后进行（cleanFields）。
    await settings.updateOne({ _id: keeperObjectId }, { $set: { userId: owner } });

    const redundant = group.filter((row) => String(row._id) !== keeperId);
    for (const row of redundant) {
      const redundantId = toObjectId(row._id);
      if (!redundantId) continue;
      await settings.deleteOne({ _id: redundantId });
      merged += 1;
    }
  }

  return { rekeyed, merged };
}

/**
 * 步骤 3：字段清洗。
 *
 * - 非 `custom` 行清空 `customName/customEmail` 并置 `unset`；
 * - `$unset` 旧字段 `committerMode` / `githubAccountId` / `workspaceId`；
 * - `tenantId` 按 owner 成员（`users.tenantId`）刷新，缺失时保留原值。
 */
export async function cleanFields(): Promise<CleanResult> {
  const settings = mongoose.connection.collection('user_commit_settings');
  const users = mongoose.connection.collection('users');
  const rows = await settings.find({}).toArray();

  let cleaned = 0;

  for (const row of rows) {
    const set: Record<string, unknown> = {};
    const unset: Record<string, ''> = { committerMode: '', githubAccountId: '', workspaceId: '' };

    if (row.committerType !== 'custom') {
      set.committerType = 'unset';
      set.customName = null;
      set.customEmail = null;
    }

    const userId = row.userId ? toObjectId(row.userId) : null;
    const user = userId ? await users.findOne({ _id: userId }, { projection: { tenantId: 1 } }) : null;
    if (user?.tenantId) set.tenantId = String(user.tenantId);

    await settings.updateOne({ _id: row._id }, { $set: set, $unset: unset });
    cleaned += 1;
  }

  return { cleaned };
}

const DEFAULT_INDEX_NAMES = ['userId_1', 'workspaceId_1'];

async function dropIndexSafe(collection: Collection, indexName: string): Promise<void> {
  try {
    await collection.dropIndex(indexName);
  } catch (err) {
    const code = (err as { code?: number }).code;
    // 26 = NamespaceNotFound, 27 = IndexNotFound
    if (code === 26 || code === 27) return;
    if (/ns not found|index not found|namespace not found/i.test((err as Error).message ?? '')) return;
    throw err;
  }
}

/**
 * 步骤 4：索引切换（先建后删）。
 *
 * 先确保 `uniq_user_commit_setting`（`{userId:1}` unique）存在，再删除
 * `uniq_workspace_commit_setting` 与 Mongoose autoIndex 默认名同键索引。
 */
export async function switchIndexes(): Promise<void> {
  const settings = mongoose.connection.collection('user_commit_settings');
  await ensureIndex(settings, { userId: 1 }, { unique: true, name: 'uniq_user_commit_setting' });

  await dropIndexSafe(settings, 'uniq_workspace_commit_setting');
  for (const indexName of DEFAULT_INDEX_NAMES) {
    await dropIndexSafe(settings, indexName);
  }
}

/**
 * 迁移入口（幂等可重入）。
 *
 * 顺序说明：转换 → 归属重键（含碰撞合并，仅改写 userId）→ 索引「先建后删」
 * → 字段清洗（此时才 `$unset workspaceId`，避免在旧唯一索引下多行置空撞唯一键）。
 */
export async function run(): Promise<void> {
  const converted = await convertGithubAccounts();
  const rekeyed = await rekeyOwners();
  await switchIndexes();
  const cleaned = await cleanFields();

  const settings = mongoose.connection.collection('user_commit_settings');
  const residualLegacyType = await settings.countDocuments({ committerType: LEGACY_COMMITTER_TYPE });
  const residualWorkspace = await settings.countDocuments({ workspaceId: { $exists: true } });

  console.log(
    `[Migration 019] converted=${converted.converted} unsetMissing=${converted.unsetFromMissingAccount} ` +
      `rekeyed=${rekeyed.rekeyed} merged=${rekeyed.merged} cleaned=${cleaned.cleaned} ` +
      `residualLegacyType=${residualLegacyType} residualWorkspace=${residualWorkspace}`,
  );
}
