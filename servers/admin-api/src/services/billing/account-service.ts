import mongoose from 'mongoose';
import {
  BillingAccount,
  type BillingOwnerType,
  type IBillingAccount,
} from '../../models/billing-account.js';
import { BillingAppliedLedger } from '../../models/billing-applied-ledger.js';
import { BillingLedger } from '../../models/billing-ledger.js';
import { AdminUser } from '../../models/admin-user.js';
import { availableCents } from './money.js';
import { accountMutex } from './keyed-mutex.js';
import { documentId } from './id.js';

export interface BillingAccountDTO {
  id: string;
  ownerType: BillingOwnerType;
  ownerId: string;
  ownerName: string;
  cashBalance: number;
  giftBalance: number;
  creditLimit: number;
  frozenAmount: number;
  availableBalance: number;
  status: string;
  insufficientSince: Date | null;
  invoiceSeq: number;
  createdAt: Date;
  updatedAt: Date;
}

export function toAccountDTO(doc: IBillingAccount & { _id: unknown }): BillingAccountDTO {
  return {
    id: documentId(doc),
    ownerType: doc.ownerType as BillingOwnerType,
    ownerId: doc.ownerId,
    ownerName: doc.ownerName ?? doc.ownerId,
    cashBalance: doc.cashBalance ?? 0,
    giftBalance: doc.giftBalance ?? 0,
    creditLimit: doc.creditLimit ?? 0,
    frozenAmount: doc.frozenAmount ?? 0,
    availableBalance: availableCents(doc),
    status: doc.status ?? 'active',
    insufficientSince: doc.insufficientSince ?? null,
    invoiceSeq: doc.invoiceSeq ?? 0,
    createdAt: (doc as unknown as { createdAt: Date }).createdAt ?? new Date(),
    updatedAt: (doc as unknown as { updatedAt: Date }).updatedAt ?? new Date(),
  };
}

/** 解析账户显示名：后台用户取用户名，前台用户取 users 集合用户名/邮箱，缺失回落 ownerId。 */
async function resolveOwnerName(ownerType: BillingOwnerType, ownerId: string): Promise<string> {
  if (ownerType === 'admin_user') {
    if (mongoose.isValidObjectId(ownerId)) {
      const admin = await AdminUser.findById(ownerId).lean<{ username?: string } | null>();
      if (admin?.username) return admin.username;
    }
    return ownerId;
  }
  // 前台用户集合由 agent-api 持有（users）；此处只读查询，不做 schema 耦合。
  const db = mongoose.connection.db;
  if (db && mongoose.isValidObjectId(ownerId)) {
    try {
      const user = (await db.collection('users').findOne(
        { _id: new mongoose.Types.ObjectId(ownerId) },
        { projection: { username: 1, email: 1, name: 1 } },
      )) as { username?: string; email?: string; name?: string } | null;
      if (user?.username) return user.username;
      if (user?.email) return user.email;
      if (user?.name) return user.name;
    } catch {
      // 集合不存在/类型不匹配时静默回落
    }
  }
  return ownerId;
}

export interface AccountServiceOptions {
  now?: () => number;
}

/** 由 ledger 派生的分池钱包快照（资金真相在 ledger，wallet 只是缓存）。 */
export interface DerivedWallet {
  ledgerTotal: number;
  ledgerGift: number;
  ledgerFrozen: number;
  cashBalance: number;
  giftBalance: number;
  frozenAmount: number;
}

/**
 * 从 ledger 聚合派生钱包分池金额（纯函数依赖已提交流水）：
 * - `ledgerTotal = Σ deltaBalance`（各池合计，含授信占用为负现金）；
 * - `ledgerGift` 由 `allocations` 的赠送池派生（充值 +、扣费 -）；
 * - 现金 = 合计 - 赠送，绝不把赠送/授信折叠进现金；
 * - 冻结 = `Σ deltaFrozen`（下限 0）。
 *
 * 因为只依赖「已提交的 ledger 行」，该派生天然幂等且崩溃可恢复：即便某次 `applyWallet`
 * 中途失败，下一次任意资金操作或对账都会把钱包校准到 ledger 真值（A4）。
 */
export async function deriveWalletFromLedger(accountId: string): Promise<DerivedWallet> {
  const [totals] = (await BillingLedger.aggregate([
    { $match: { accountId: new mongoose.Types.ObjectId(accountId) } },
    {
      $group: {
        _id: null,
        balance: { $sum: '$deltaBalance' },
        frozen: { $sum: '$deltaFrozen' },
      },
    },
  ])) as Array<{ balance: number; frozen: number }>;

  const poolRows = (await BillingLedger.aggregate([
    { $match: { accountId: new mongoose.Types.ObjectId(accountId) } },
    { $unwind: { path: '$allocations', preserveNullAndEmptyArrays: false } },
    {
      $group: {
        _id: '$allocations.pool',
        charged: {
          $sum: { $cond: [{ $eq: ['$bizType', 'charge'] }, '$allocations.amount', 0] },
        },
        recharged: {
          $sum: { $cond: [{ $eq: ['$bizType', 'recharge'] }, '$allocations.amount', 0] },
        },
      },
    },
  ])) as Array<{ _id: string; charged: number; recharged: number }>;

  const giftPool = poolRows.find((row) => row._id === 'gift');
  const ledgerGift = Math.round((giftPool?.recharged ?? 0) - (giftPool?.charged ?? 0));
  const ledgerTotal = Math.round(totals?.balance ?? 0);
  const ledgerFrozen = Math.max(0, Math.round(totals?.frozen ?? 0));
  return {
    ledgerTotal,
    ledgerGift,
    ledgerFrozen,
    cashBalance: ledgerTotal - ledgerGift,
    giftBalance: ledgerGift,
    frozenAmount: ledgerFrozen,
  };
}

/** 账户服务：get-or-create、查询、状态/授信调整、精确核算。 */
export class AccountService {
  private readonly now: () => number;

  constructor(options: AccountServiceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  async getOrCreate(
    ownerType: BillingOwnerType,
    ownerId: string,
    ownerName?: string,
  ): Promise<BillingAccountDTO> {
    const name = ownerName || (await resolveOwnerName(ownerType, ownerId));
    const doc = await BillingAccount.findOneAndUpdate(
      { ownerType, ownerId },
      { $setOnInsert: { cashBalance: 0, giftBalance: 0, creditLimit: 0, frozenAmount: 0, invoiceSeq: 0, status: 'active' }, $set: { ownerName: name } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean<IBillingAccount | null>();
    if (!doc) throw new Error(`failed to get-or-create billing account for ${ownerType}:${ownerId}`);
    return toAccountDTO(doc as IBillingAccount & { _id: unknown });
  }

  async getById(accountId: string): Promise<BillingAccountDTO | null> {
    if (!mongoose.isValidObjectId(accountId)) return null;
    const doc = await BillingAccount.findById(accountId).lean<IBillingAccount | null>();
    return doc ? toAccountDTO(doc as IBillingAccount & { _id: unknown }) : null;
  }

  async list(options: {
    keyword?: string;
    ownerType?: BillingOwnerType;
    page?: number;
    pageSize?: number;
  } = {}): Promise<BillingAccountDTO[]> {
    const filter: Record<string, unknown> = {};
    if (options.ownerType) filter.ownerType = options.ownerType;
    if (options.keyword) {
      const escaped = options.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { ownerName: { $regex: escaped, $options: 'i' } },
        { ownerId: { $regex: escaped, $options: 'i' } },
      ];
    }
    // P1：page 同时限定整数与上界（防 `page=2^31` 的 skip≈4.5e10 慢查询）；pageSize 同理。
    const page = Math.min(100_000, Math.max(1, Number.isInteger(options.page) ? (options.page as number) : 1));
    const pageSize = Math.min(
      200,
      Math.max(1, Number.isInteger(options.pageSize) ? (options.pageSize as number) : 50),
    );
    const docs = await BillingAccount.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean<IBillingAccount[]>();
    return docs.map((doc) => toAccountDTO(doc as IBillingAccount & { _id: unknown }));
  }

  async setCreditLimit(accountId: string, creditLimitCents: number): Promise<BillingAccountDTO> {
    if (creditLimitCents < 0) throw new Error('授信额度不能为负数');
    const doc = await BillingAccount.findByIdAndUpdate(
      accountId,
      { $set: { creditLimit: Math.round(creditLimitCents) } },
      { new: true },
    ).lean<IBillingAccount | null>();
    if (!doc) throw new Error('账户不存在');
    return toAccountDTO(doc as IBillingAccount & { _id: unknown });
  }

  async setStatus(accountId: string, status: string): Promise<BillingAccountDTO> {
    if (status !== 'active' && status !== 'frozen') throw new Error('非法账户状态');
    const doc = await BillingAccount.findByIdAndUpdate(
      accountId,
      { $set: { status } },
      { new: true },
    ).lean<IBillingAccount | null>();
    if (!doc) throw new Error('账户不存在');
    return toAccountDTO(doc as IBillingAccount & { _id: unknown });
  }

  /** 余额恢复（如充值到账）时清零欠费计时。 */
  async clearInsufficient(accountId: string): Promise<void> {
    await BillingAccount.updateOne({ _id: accountId }, { $set: { insufficientSince: null } });
  }

  /** 标记欠费计时起点（已存在则不重置）。 */
  async markInsufficient(accountId: string, at: Date): Promise<void> {
    await BillingAccount.updateOne(
      { _id: accountId, insufficientSince: null },
      { $set: { insufficientSince: at } },
    );
  }

  /**
   * 精确核算：以 ledger 累加为准校准 wallet 快照。**按池对账**，绝不把赠送/授信折叠进现金：
   * 不变式为 `Σ deltaBalance == cashBalance + giftBalance`（授信占用体现为现金负值），
   * 赠送池由 ledger 的 `allocations`（赠送/授信拆池明细）单独派生。发现差异时写 adjust 流水
   * （delta=0）留痕，并以 ledger 派生的分池金额回写钱包。
   */
  async reconcileAccount(accountId: string): Promise<{
    account: BillingAccountDTO;
    error: {
      accountId: string;
      walletCash: number;
      ledgerCash: number;
      walletGift: number;
      ledgerGift: number;
      walletFrozen: number;
      ledgerFrozen: number;
    } | null;
  }> {
    if (!mongoose.isValidObjectId(accountId)) throw new Error('账户不存在');
    // R2-1：与 PaymentService 的全部钱包写入共用同一把账户锁——否则「校准回写」与在途
    // `$inc`/自愈交错，会把刚写入的增量覆盖掉（或反之）。
    return accountMutex.runExclusive(`account:${accountId}`, () =>
      this.reconcileAccountLocked(accountId),
    );
  }

  private async reconcileAccountLocked(accountId: string): Promise<{
    account: BillingAccountDTO;
    error: {
      accountId: string;
      walletCash: number;
      ledgerCash: number;
      walletGift: number;
      ledgerGift: number;
      walletFrozen: number;
      ledgerFrozen: number;
    } | null;
  }> {
    const account = await BillingAccount.findById(accountId).lean<IBillingAccount | null>();
    if (!account) throw new Error('账户不存在');

    const derived = await deriveWalletFromLedger(accountId);
    const ledgerCash = derived.cashBalance;
    const ledgerGift = derived.giftBalance;
    const ledgerFrozen = derived.frozenAmount;

    const walletCash = Math.round(account.cashBalance ?? 0);
    const walletGift = Math.round(account.giftBalance ?? 0);
    const walletFrozen = Math.round(account.frozenAmount ?? 0);

    const mismatch =
      walletCash !== ledgerCash || walletGift !== ledgerGift || walletFrozen !== ledgerFrozen;
    // R1/A-2：无论是否有漂移，都把最近 ledger 行同步进「已应用水位」——防止「钱包已等于 ledger 真值
    // 但水位缺失」（如历史数据/对账后）时重放二次扣减。有漂移时同时按 ledger 真值回写分池余额。
    const recent = (
      await BillingLedger.find({ accountId: new mongoose.Types.ObjectId(accountId) })
        .sort({ createdAt: -1 })
        .limit(1000)
        .select({ _id: 1 })
        .lean<Array<{ _id: mongoose.Types.ObjectId }>>()
    ).map((row) => String(row._id));
    if (mismatch) {
      const stamp = `reconcile:${accountId}:${this.now()}:${Math.random().toString(16).slice(2, 8)}`;
      await BillingLedger.create({
        accountId: new mongoose.Types.ObjectId(accountId),
        pool: 'cash',
        bizType: 'adjust',
        deltaBalance: 0,
        deltaFrozen: 0,
        allocations: [],
        bizId: stamp,
        idempotentKey: stamp,
      }).catch((err: { code?: number }) => {
        if (err.code !== 11000) throw err;
      });
      await BillingAccount.updateOne(
        { _id: accountId },
        {
          $set: {
            cashBalance: ledgerCash,
            giftBalance: ledgerGift,
            frozenAmount: ledgerFrozen,
            appliedLedgerIds: recent,
          },
        },
      );
    } else {
      await BillingAccount.updateOne(
        { _id: accountId },
        { $set: { appliedLedgerIds: recent } },
      );
    }
    // A-2/R2-1：钱包此刻**已**被校准到 ledger 真值（有漂移已回写、无漂移本就相等），
    // 才可把全部历史行登记为已应用——顺序必须在钱包回写**之后**，否则会先宣称「已应用」
    // 而钱包尚未写，重放被跳过 → 账实不符（违反 `markAllLedgerApplied` 自身不变量）。
    await this.markAllLedgerApplied(accountId);

    const updated = mismatch
      ? await BillingAccount.findById(accountId).lean<IBillingAccount | null>()
      : account;
    return {
      account: toAccountDTO(updated as IBillingAccount & { _id: unknown }),
      error: mismatch
        ? {
            accountId,
            walletCash,
            ledgerCash,
            walletGift,
            ledgerGift,
            walletFrozen,
            ledgerFrozen,
          }
        : null,
    };
  }

  /**
   * A-2：把该账户**全部** ledger 行登记为「已应用到钱包」。
   *
   * 仅在对账把钱包校准到 ledger 真值之后调用——此刻钱包 = Σledger，所有历史行在语义上
   * 都已生效，登记全部行才能让「水位淘汰后的重放」保持幂等（幂等标记不淘汰）。
   * 使用 `bulkWrite` + `upsert` 幂等；**失败向上抛**（R2-1：吞错会让「已校准但未登记」静默
   * 留下重放窗口，由调用方按对账失败上报，下一次对账重试）。
   */
  async markAllLedgerApplied(accountId: string): Promise<void> {
    if (!mongoose.isValidObjectId(accountId)) return;
    const objectId = new mongoose.Types.ObjectId(accountId);
    const rows = await BillingLedger.find({ accountId: objectId })
      .select({ _id: 1 })
      .lean<Array<{ _id: mongoose.Types.ObjectId }>>();
    if (rows.length === 0) return;
    const now = new Date(this.now());
    const chunkSize = 500;
    for (let start = 0; start < rows.length; start += chunkSize) {
      const chunk = rows.slice(start, start + chunkSize);
      await BillingAppliedLedger.bulkWrite(
        chunk.map((row) => ({
          updateOne: {
            filter: { accountId: objectId, ledgerId: String(row._id) },
            update: {
              $set: { walletApplied: true, appliedAt: now, claimedAt: null },
              $setOnInsert: { accountId: objectId, ledgerId: String(row._id) },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
  }
}

export const accountService = new AccountService();
