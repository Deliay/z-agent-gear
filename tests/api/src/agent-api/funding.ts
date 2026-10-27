import mongoose from 'mongoose';
import { adminGql, ensureAdminLogin } from '../admin-api/helpers.js';

const ADMIN_BASE = (process.env.ADMIN_API_URL || 'http://localhost:10003/graphql').replace(
  /\/graphql\/?$/,
  '',
);
const TOKEN = process.env.INTERNAL_API_TOKEN;
const MONGO_URI = process.env.MONGODB_URI;

async function mongoDb(): Promise<mongoose.mongo.Db | null> {
  if (!MONGO_URI) return null;
  if (mongoose.connection.readyState === 0) await mongoose.connect(MONGO_URI);
  return mongoose.connection.db ?? null;
}

/** 直写 billingaccounts（无内部 token 时的兜底）。 */
async function fundViaMongo(userId: string, username: string, cents: number): Promise<boolean> {
  const db = await mongoDb();
  if (!db) return false;
  const now = new Date();
  await db.collection('billingaccounts').updateOne(
    { ownerType: 'front_user', ownerId: userId },
    {
      $set: {
        ownerType: 'front_user',
        ownerId: userId,
        ownerName: username,
        cashBalance: cents,
        giftBalance: 0,
        creditLimit: 0,
        frozenAmount: 0,
        status: 'active',
        insufficientSince: null,
        updatedAt: now,
      },
      $setOnInsert: { invoiceSeq: 0, createdAt: now },
    },
    { upsert: true },
  );
  return true;
}

/** 内部 REST 建账户 + 后台 GraphQL 充值（真实链路）。 */
async function fundViaAdmin(userId: string, username: string, cents: number): Promise<boolean> {
  if (!TOKEN) return false;
  try {
    const accountRes = await fetch(
      `${ADMIN_BASE}/internal/billing/account?ownerType=front_user&ownerId=${encodeURIComponent(
        userId,
      )}&ownerName=${encodeURIComponent(username)}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    if (!accountRes.ok) return false;
    const account = (await accountRes.json()) as { id?: string };
    if (!account.id) return false;
    const adminToken = await ensureAdminLogin();
    const result = await adminGql<{ rechargeBillingAccount: { id: string } }>(
      `mutation Recharge($id: ID!, $amount: Float!, $key: String!) {
      rechargeBillingAccount(accountId: $id, amount: $amount, note: "api-test", idempotencyKey: $key) { id }
    }`,
      { id: account.id, amount: cents / 100, key: `api-test-fund:${userId}` },
      adminToken,
    );
    return Boolean(result.data?.rechargeBillingAccount);
  } catch {
    return false;
  }
}

/** 为前台测试用户准备余额（默认 100 credits；优先真实充值链路，缺 token 时直写 Mongo）。 */
export async function fundFrontUser(userId: string, username: string, cents = 10_000): Promise<void> {
  if (await fundViaAdmin(userId, username, cents)) return;
  if (await fundViaMongo(userId, username, cents)) return;
  throw new Error('无法为测试用户充值：缺少 INTERNAL_API_TOKEN/ADMIN_API_URL 与 MONGODB_URI');
}
