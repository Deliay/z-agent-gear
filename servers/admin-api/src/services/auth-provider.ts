import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { logger as rootLogger } from '../observability/logger.js';
import { AuthProvider } from '../models/auth-provider.js';
import { encrypt } from './crypto.js';

const logger = rootLogger.child({ component: 'auth-provider' });

export const GITHUB_OAUTH_DISPLAY_NAME = 'GitHub';
export const DEFAULT_OIDC_SCOPES = 'openid profile email';
export const OAUTH_CALLBACK_PATH = '/api/auth/oauth/callback';

export interface OidcProviderInput {
  displayName?: string | null;
  issuer?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  scopes?: string | null;
  enabled?: boolean | null;
  enableFrontLogin?: boolean | null;
  enableAdminLogin?: boolean | null;
}

export interface GithubOauthInput {
  clientId?: string | null;
  clientSecret?: string | null;
  enabled?: boolean | null;
  enableFrontLogin?: boolean | null;
  enableAdminLogin?: boolean | null;
}

interface ProviderDoc {
  _id: { toString(): string };
  type: string;
  displayName: string;
  issuer?: string | null;
  clientId: string;
  scopes?: string | null;
  enabled: boolean;
  enableFrontLogin: boolean;
  enableAdminLogin: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** 回调地址（展示用）：agent-api 对外基地址 + 统一回调路径。 */
export function oauthCallbackUrl(): string {
  const base = (config.agentApiPublicUrl || config.agentApiUrl || '').replace(/\/+$/, '');
  return `${base}${OAUTH_CALLBACK_PATH}`;
}

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** 校验 OIDC issuer：合法 http(s) URL；生产环境强制 https（开发允许 http 供 fake IdP / 本地 IdP）。 */
export function validateIssuer(issuer: string): string {
  const trimmed = issuer.trim();
  const url = parseUrl(trimmed);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error('Issuer must be a valid http(s) URL');
  }
  if (config.nodeEnv === 'production' && url.protocol !== 'https:') {
    throw new Error('Issuer must use https in production');
  }
  return trimmed.replace(/\/+$/, '');
}

export function validateDisplayName(displayName: unknown): string {
  if (typeof displayName !== 'string') {
    throw new Error('Display name is required');
  }
  const trimmed = displayName.trim();
  if (trimmed.length < 1 || trimmed.length > 64) {
    throw new Error('Display name must be between 1 and 64 characters');
  }
  return trimmed;
}

export function validateClientId(clientId: unknown): string {
  if (typeof clientId !== 'string' || clientId.trim().length === 0) {
    throw new Error('Client ID is required');
  }
  const trimmed = clientId.trim();
  if (trimmed.length > 256) {
    throw new Error('Client ID must be at most 256 characters');
  }
  return trimmed;
}

export function validateClientSecret(clientSecret: unknown): string {
  if (typeof clientSecret !== 'string' || clientSecret.length === 0) {
    throw new Error('Client secret is required');
  }
  return clientSecret;
}

export function validateScopes(scopes: unknown): string {
  const value = typeof scopes === 'string' ? scopes.trim() : '';
  if (value.length === 0) {
    throw new Error('Scopes must not be empty');
  }
  return value;
}

/**
 * 配置读写服务（`authproviders` 唯一写方）。
 *
 * 出参一律经 `mapProvider` 白名单装配：**恒不含 clientSecret（明文/密文）**，以 `hasSecret` 代替。
 */
export class AuthProviderService {
  private mapProvider(doc: ProviderDoc) {
    return {
      id: doc._id.toString(),
      type: doc.type,
      displayName: doc.displayName,
      issuer: doc.issuer ?? '',
      clientId: doc.clientId,
      scopes: doc.scopes ?? DEFAULT_OIDC_SCOPES,
      enabled: doc.enabled,
      enableFrontLogin: doc.enableFrontLogin,
      enableAdminLogin: doc.enableAdminLogin,
      hasSecret: true,
      callbackUrl: oauthCallbackUrl(),
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  }

  private mapGithub(doc: ProviderDoc) {
    return {
      id: doc._id.toString(),
      type: doc.type,
      clientId: doc.clientId,
      enabled: doc.enabled,
      enableFrontLogin: doc.enableFrontLogin,
      enableAdminLogin: doc.enableAdminLogin,
      hasSecret: true,
      callbackUrl: oauthCallbackUrl(),
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  }

  async listOidcProviders() {
    const docs = (await AuthProvider.find({ type: 'oidc' })
      .sort({ createdAt: 1 })
      .lean()) as unknown as ProviderDoc[];
    return docs.map((doc) => this.mapProvider(doc));
  }

  async getGithubConfig() {
    const doc = (await AuthProvider.findOne({ type: 'github_oauth' }).lean()) as unknown as
      | ProviderDoc
      | null;
    return doc ? this.mapGithub(doc) : null;
  }

  async createOidcProvider(input: OidcProviderInput) {
    const displayName = validateDisplayName(input.displayName);
    const issuer = validateIssuer(String(input.issuer ?? ''));
    const clientId = validateClientId(input.clientId);
    const clientSecret = validateClientSecret(input.clientSecret);
    const scopes = input.scopes == null ? DEFAULT_OIDC_SCOPES : validateScopes(input.scopes);

    const doc = (await AuthProvider.create({
      type: 'oidc',
      displayName,
      issuer,
      clientId,
      encryptedClientSecret: encrypt(clientSecret),
      scopes,
      enabled: input.enabled ?? false,
      enableFrontLogin: input.enableFrontLogin ?? true,
      enableAdminLogin: input.enableAdminLogin ?? false,
    })) as unknown as ProviderDoc;
    logger.info({ providerId: doc._id.toString() }, 'oidc provider created');
    return this.mapProvider(doc);
  }

  async updateOidcProvider(id: string, input: OidcProviderInput) {
    if (!isValidObjectId(id)) return null;
    const doc = (await AuthProvider.findOne({ _id: id, type: 'oidc' })) as unknown as ProviderDoc | null;
    if (!doc) return null;

    const update: Record<string, unknown> = {};
    if (input.displayName !== undefined && input.displayName !== null) {
      update.displayName = validateDisplayName(input.displayName);
    }
    if (input.issuer !== undefined && input.issuer !== null) {
      update.issuer = validateIssuer(input.issuer);
    }
    if (input.clientId !== undefined && input.clientId !== null) {
      update.clientId = validateClientId(input.clientId);
    }
    if (input.scopes !== undefined && input.scopes !== null) {
      update.scopes = validateScopes(input.scopes);
    }
    if (input.clientSecret !== undefined && input.clientSecret !== null) {
      update.encryptedClientSecret = encrypt(validateClientSecret(input.clientSecret));
    }
    if (typeof input.enabled === 'boolean') update.enabled = input.enabled;
    if (typeof input.enableFrontLogin === 'boolean') update.enableFrontLogin = input.enableFrontLogin;
    if (typeof input.enableAdminLogin === 'boolean') update.enableAdminLogin = input.enableAdminLogin;

    const updated = (await AuthProvider.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true },
    ).lean()) as unknown as ProviderDoc | null;
    return updated ? this.mapProvider(updated) : null;
  }

  async deleteOidcProvider(id: string): Promise<boolean> {
    if (!isValidObjectId(id)) return false;
    const result = await AuthProvider.deleteOne({ _id: id, type: 'oidc' });
    return result.deletedCount > 0;
  }

  /**
   * GitHub OAuth 配置 upsert（全平台单条）。
   * 首次创建要求 clientId + clientSecret；更新时省略 clientSecret = 保持不变。
   * 并发 upsert 由部分唯一索引兜底（E11000 → 复读后按更新处理）。
   */
  async upsertGithubConfig(input: GithubOauthInput) {
    const existing = (await AuthProvider.findOne({ type: 'github_oauth' }).lean()) as unknown as
      | ProviderDoc
      | null;

    if (!existing) {
      const clientId = validateClientId(input.clientId);
      const clientSecret = validateClientSecret(input.clientSecret);
      try {
        const created = (await AuthProvider.create({
          type: 'github_oauth',
          displayName: GITHUB_OAUTH_DISPLAY_NAME,
          issuer: null,
          clientId,
          encryptedClientSecret: encrypt(clientSecret),
          scopes: null,
          enabled: input.enabled ?? false,
          enableFrontLogin: input.enableFrontLogin ?? true,
          enableAdminLogin: input.enableAdminLogin ?? false,
        })) as unknown as ProviderDoc;
        logger.info({ providerId: created._id.toString() }, 'github oauth config created');
        return this.mapGithub(created);
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
        // 并发创建：回读既有行，按更新路径处理（幂等）
        const raced = (await AuthProvider.findOne({ type: 'github_oauth' }).lean()) as unknown as
          | ProviderDoc
          | null;
        if (!raced) throw err;
        return this.applyGithubUpdate(raced._id.toString(), input);
      }
    }

    return this.applyGithubUpdate(existing._id.toString(), input);
  }

  private async applyGithubUpdate(id: string, input: GithubOauthInput) {
    const update: Record<string, unknown> = {};
    if (input.clientId !== undefined && input.clientId !== null) {
      update.clientId = validateClientId(input.clientId);
    }
    if (input.clientSecret !== undefined && input.clientSecret !== null) {
      update.encryptedClientSecret = encrypt(validateClientSecret(input.clientSecret));
    }
    if (typeof input.enabled === 'boolean') update.enabled = input.enabled;
    if (typeof input.enableFrontLogin === 'boolean') update.enableFrontLogin = input.enableFrontLogin;
    if (typeof input.enableAdminLogin === 'boolean') update.enableAdminLogin = input.enableAdminLogin;

    const updated = (await AuthProvider.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true },
    ).lean()) as unknown as ProviderDoc | null;
    if (!updated) throw new Error('GitHub OAuth config not found');
    return this.mapGithub(updated);
  }

  /** 登录页免登录查询：仅返回 enabled 且对应 surface 已开启的配置。 */
  async listForSurface(surface: 'front' | 'admin') {
    const filter =
      surface === 'front'
        ? { enabled: true, enableFrontLogin: true }
        : { enabled: true, enableAdminLogin: true };
    const docs = (await AuthProvider.find(filter).sort({ createdAt: 1 }).lean()) as unknown as ProviderDoc[];
    return docs.map((doc) => ({
      id: doc._id.toString(),
      type: doc.type,
      displayName: doc.type === 'github_oauth' ? GITHUB_OAUTH_DISPLAY_NAME : doc.displayName,
    }));
  }
}

export const authProviderService = new AuthProviderService();
