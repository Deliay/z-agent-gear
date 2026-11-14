import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createAuthProviderIndexes, run } from './022-auth-providers.js';

const h = vi.hoisted(() => ({
  collections: new Map<string, { createIndex: ReturnType<typeof vi.fn>; indexes: ReturnType<typeof vi.fn> }>(),
}));

describe('migration 022-auth-providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.collections.clear();
    for (const name of ['authproviders', 'adminexternallogins']) {
      h.collections.set(name, {
        createIndex: vi.fn(async () => 'idx'),
        indexes: vi.fn(async () => []),
      });
    }
    vi.spyOn(mongoose.connection, 'collection').mockImplementation(
      ((name: string) => h.collections.get(name)) as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T-MIG-AP1: authproviders 建 github 部分唯一 + type/enabled 索引', async () => {
    await createAuthProviderIndexes();
    const providers = h.collections.get('authproviders')!;
    expect(providers.createIndex).toHaveBeenCalledWith(
      { type: 1 },
      {
        unique: true,
        name: 'uniq_auth_provider_github',
        partialFilterExpression: { type: 'github_oauth' },
      },
    );
    expect(providers.createIndex).toHaveBeenCalledWith(
      { type: 1, enabled: 1 },
      { name: 'auth_provider_type_enabled' },
    );
  });

  it('T-MIG-AP2: adminexternallogins 两条唯一索引', async () => {
    await createAuthProviderIndexes();
    const bindings = h.collections.get('adminexternallogins')!;
    expect(bindings.createIndex).toHaveBeenCalledWith(
      { providerId: 1, issuer: 1, subject: 1 },
      { unique: true, name: 'uniq_admin_external_login_subject' },
    );
    expect(bindings.createIndex).toHaveBeenCalledWith(
      { adminUserId: 1, providerId: 1 },
      { unique: true, name: 'uniq_admin_external_login_admin_provider' },
    );
  });

  it('T-MIG-AP3: 重复执行幂等（同名同 spec 由 Mongo 视为 no-op）', async () => {
    await createAuthProviderIndexes();
    await createAuthProviderIndexes();
    expect(h.collections.get('authproviders')!.createIndex).toHaveBeenCalledTimes(4);
  });

  it('run 成功并记录索引', async () => {
    await run();
    expect(h.collections.get('authproviders')!.indexes).toHaveBeenCalled();
    expect(h.collections.get('adminexternallogins')!.indexes).toHaveBeenCalled();
  });
});
