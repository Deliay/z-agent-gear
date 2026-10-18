import mongoose from 'mongoose';
import {
  BillingAccount,
  type BillingOwnerType,
  type IBillingAccount,
} from '../../models/billing-account.js';
import { BillingLedger } from '../../models/billing-ledger.js';
import { AdminUser } from '../../models/admin-user.js';
import { availableCents } from './money.js';
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
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, options.pageSize ?? 50));
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
   * 精确核算：以 ledger 累加为准校准 wallet 快照；发现差异时写 adjust 流水（delta=0）留痕。
   * 返回校准后的账户与差错（null 表示一致）。
   */
  async reconcileAccount(accountId: string): Promise<{
    account: BillingAccountDTO;
    error: {
      accountId: string;
      walletCash: number;
      ledgerCash: number;
      walletFrozen: number;
      ledgerFrozen: number;
    } | null;
  }> {
    if (!mongoose.isValidObjectId(accountId)) throw new Error('账户不存在');
    const account = await BillingAccount.findById(accountId).lean<IBillingAccount | null>();
    if (!account) throw new Error('账户不存在');

    const rows = (await BillingLedger.aggregate([
      { $match: { accountId: new mongoose.Types.ObjectId(accountId) } },
      {
        $group: {
          _id: null,
          balance: { $sum: '$deltaBalance' },
          frozen: { $sum: '$deltaFrozen' },
        },
      },
    ])) as Array<{ balance: number; frozen: number }>;
    const ledgerCash = Math.round(rows[0]?.balance ?? 0);
    const ledgerFrozen = Math.max(0, Math.round(rows[0]?.frozen ?? 0));
    const walletCash = Math.round(account.cashBalance ?? 0);
    const walletFrozen = Math.round(account.frozenAmount ?? 0);

    const mismatch = walletCash !== ledgerCash || walletFrozen !== ledgerFrozen;
    if (mismatch) {
      const stamp = `reconcile:${accountId}:${this.now()}:${Math.random().toString(16).slice(2, 8)}`;
      await BillingLedger.create({
        accountId: new mongoose.Types.ObjectId(accountId),
        pool: 'cash',
        bizType: 'adjust',
        deltaBalance: 0,
        deltaFrozen: 0,
        bizId: stamp,
        idempotentKey: stamp,
      }).catch((err: { code?: number }) => {
        if (err.code !== 11000) throw err;
      });
      await BillingAccount.updateOne(
        { _id: accountId },
        { $set: { cashBalance: ledgerCash, frozenAmount: ledgerFrozen } },
      );
    }

    const updated = mismatch
      ? await BillingAccount.findById(accountId).lean<IBillingAccount | null>()
      : account;
    return {
      account: toAccountDTO(updated as IBillingAccount & { _id: unknown }),
      error: mismatch
        ? { accountId, walletCash, ledgerCash, walletFrozen, ledgerFrozen }
        : null,
    };
  }
}

export const accountService = new AccountService();
