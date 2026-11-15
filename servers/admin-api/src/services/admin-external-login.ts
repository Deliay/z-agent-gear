import mongoose from 'mongoose';
import { AdminExternalLogin } from '../models/admin-external-login.js';
import { AuthProvider } from '../models/auth-provider.js';
import { GITHUB_OAUTH_DISPLAY_NAME } from './auth-provider.js';

export interface ExternalIdentity {
  providerId: string;
  issuer?: string | null;
  subject: string;
  externalUsername: string;
  displayName?: string | null;
}

interface BindingDoc {
  _id: { toString(): string };
  adminUserId: { toString(): string };
  providerId: { toString(): string };
  issuer?: string | null;
  subject: string;
  externalUsername: string;
  displayName?: string | null;
  createdAt: Date;
  lastLoginAt?: Date | null;
}

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

async function providerDisplayName(providerId: unknown): Promise<string> {
  const provider = await AuthProvider.findById(providerId)
    .select('type displayName')
    .lean() as { type?: string; displayName?: string } | null;
  if (!provider) return '';
  return provider.type === 'github_oauth'
    ? GITHUB_OAUTH_DISPLAY_NAME
    : provider.displayName ?? '';
}

/**
 * 后台外部身份绑定关系（`adminexternallogins` 唯一写方）。
 *
 * - `bind`：幂等 upsert（每管理员每 provider 一条；同一外部身份只允许绑定一名管理员）；
 * - `listByAdmin`：当前管理员已绑定身份（含 provider 展示名）；
 * - `unbind`：仅本人可解绑；
 * - `findBound`：后台登录换票用（命中更新 lastLoginAt）。
 */
export class AdminExternalLoginService {
  async bind(adminUserId: string, identity: ExternalIdentity) {
    if (!isValidObjectId(adminUserId) || !isValidObjectId(identity.providerId)) {
      throw new Error('INVALID_ID');
    }
    const filter = { adminUserId, providerId: identity.providerId };
    const update = {
      $set: {
        issuer: identity.issuer ?? null,
        subject: identity.subject,
        externalUsername: identity.externalUsername,
        displayName: identity.displayName ?? null,
        lastLoginAt: new Date(),
      },
    };
    try {
      const doc = await AdminExternalLogin.findOneAndUpdate(filter, update, {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }).lean();
      return doc as unknown as BindingDoc;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      // 唯一冲突：该外部身份已绑定到其他管理员，或并发 upsert。回读判定。
      const existing = (await AdminExternalLogin.findOne({
        providerId: identity.providerId,
        issuer: identity.issuer ?? null,
        subject: identity.subject,
      }).lean()) as unknown as BindingDoc | null;
      if (!existing) throw err;
      if (existing.adminUserId.toString() !== adminUserId) {
        throw new Error('EXTERNAL_IDENTITY_ALREADY_BOUND');
      }
      const updated = await AdminExternalLogin.findByIdAndUpdate(
        existing._id,
        { $set: update.$set },
        { new: true },
      ).lean();
      return updated as unknown as BindingDoc;
    }
  }

  async listByAdmin(adminUserId: string) {
    const docs = (await AdminExternalLogin.find({ adminUserId })
      .sort({ createdAt: 1 })
      .lean()) as unknown as BindingDoc[];
    return Promise.all(
      docs.map(async (doc) => ({
        id: doc._id.toString(),
        providerId: doc.providerId.toString(),
        providerDisplayName: await providerDisplayName(doc.providerId),
        externalUsername: doc.externalUsername,
        createdAt: doc.createdAt.toISOString(),
      })),
    );
  }

  async unbind(adminUserId: string, id: string): Promise<boolean> {
    if (!isValidObjectId(id)) return false;
    const result = await AdminExternalLogin.deleteOne({ _id: id, adminUserId });
    return result.deletedCount > 0;
  }

  async findBound(identity: {
    providerId: string;
    issuer?: string | null;
    subject: string;
  }): Promise<BindingDoc | null> {
    if (!isValidObjectId(identity.providerId)) return null;
    const doc = (await AdminExternalLogin.findOne({
      providerId: identity.providerId,
      issuer: identity.issuer ?? null,
      subject: identity.subject,
    })) as unknown as BindingDoc | null;
    if (!doc) return null;
    await AdminExternalLogin.updateOne({ _id: doc._id }, { $set: { lastLoginAt: new Date() } });
    return doc;
  }
}

export const adminExternalLoginService = new AdminExternalLoginService();
