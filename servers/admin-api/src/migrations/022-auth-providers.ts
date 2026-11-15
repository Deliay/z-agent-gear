import mongoose from 'mongoose';
import { logger } from '../observability/logger.js';

const log = logger.child({ component: 'migration/022-auth-providers' });

export const name = '022-auth-providers';

type Collection = ReturnType<typeof mongoose.connection.collection>;

/**
 * 022-auth-providers：第三方登录配置与后台绑定索引（幂等）。
 *
 * - `authproviders`：
 *   - `{type:1}` 部分唯一（partialFilterExpression `{type:'github_oauth'}`）→ GitHub OAuth 全平台单条；
 *   - `{type:1, enabled:1}` → 登录页按类型 + 启用状态查询。
 * - `adminexternallogins`：
 *   - `{providerId:1, issuer:1, subject:1}` 唯一 → 同一外部身份只能绑定一名管理员；
 *   - `{adminUserId:1, providerId:1}` 唯一 → 每管理员每 provider 一条。
 *
 * 只建索引、不回填（新集合无存量）。重复执行无副作用（同名同 spec 幂等）。
 */
export async function createAuthProviderIndexes(): Promise<void> {
  const providers = mongoose.connection.collection('authproviders') as Collection;
  await providers.createIndex(
    { type: 1 },
    {
      unique: true,
      name: 'uniq_auth_provider_github',
      partialFilterExpression: { type: 'github_oauth' },
    },
  );
  await providers.createIndex({ type: 1, enabled: 1 }, { name: 'auth_provider_type_enabled' });

  const bindings = mongoose.connection.collection('adminexternallogins') as Collection;
  await bindings.createIndex(
    { providerId: 1, issuer: 1, subject: 1 },
    { unique: true, name: 'uniq_admin_external_login_subject' },
  );
  await bindings.createIndex(
    { adminUserId: 1, providerId: 1 },
    { unique: true, name: 'uniq_admin_external_login_admin_provider' },
  );
}

export async function run(): Promise<void> {
  await createAuthProviderIndexes();

  const providers = await mongoose.connection
    .collection('authproviders')
    .indexes()
    .catch(() => []);
  const bindings = await mongoose.connection
    .collection('adminexternallogins')
    .indexes()
    .catch(() => []);
  log.info(
    {
      providerIndexes: providers.map((index) => index.name),
      bindingIndexes: bindings.map((index) => index.name),
    },
    'migration completed',
  );
}
