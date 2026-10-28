import { describe, it, expect } from 'vitest';
import { createFrontUser } from '../support/front-users.js';
import {
  adminGql,
  adminGqlRequest,
  ADMIN_TEST_PASSWORD,
  ensureAdminLogin,
  setAdminMustChangePassword,
  createFrontUserToken,
} from './helpers.js';

const ADMIN_ME = `
  query AdminMe {
    adminMe { id username mustChangePassword createdAt updatedAt }
  }
`;

const LOGIN = `
  mutation AdminLogin($username: String!, $password: String!) {
    adminLogin(username: $username, password: $password) {
      token
      admin { id username mustChangePassword }
    }
  }
`;

const CHANGE_PASSWORD = `
  mutation ChangeAdminPassword($oldPassword: String!, $newPassword: String!) {
    changeAdminPassword(oldPassword: $oldPassword, newPassword: $newPassword) {
      token
      admin { id username mustChangePassword }
    }
  }
`;

const INTROSPECTION = `
  query Introspect {
    __schema { mutationType { fields { name } } }
  }
`;

describe('Admin Auth API', () => {
  it('should normalize the admin account and return a usable token', async () => {
    const token = await ensureAdminLogin();
    expect(token).toBeTruthy();

    const me = await adminGql<{ adminMe: { username: string; mustChangePassword: boolean } }>(
      ADMIN_ME,
      undefined,
      token,
    );
    expect(me.errors).toBeUndefined();
    expect(me.data!.adminMe.username).toBe('admin');
    expect(me.data!.adminMe.mustChangePassword).toBe(false);
  });

  it('should return null for adminMe without a token (T-A6)', async () => {
    const body = await adminGql<{ adminMe: unknown }>(ADMIN_ME);
    // adminMe 未认证返回 null（不报错），符合契约
    expect(body.data?.adminMe ?? null).toBeNull();
  });

  it('should reject a forged / user-side token (T-A6)', async () => {
    const body = await adminGql<{ adminMe: unknown }>(ADMIN_ME, undefined, 'not-a-valid-admin-token');
    expect(body.data?.adminMe ?? null).toBeNull();
  });

  it('T-A6: rejects a real user-side JWT and reports UNAUTHENTICATED (separate secret)', async () => {
    const userToken = await createFrontUserToken();

    const me = await adminGql<{ adminMe: unknown }>(ADMIN_ME, undefined, userToken);
    expect(me.data?.adminMe ?? null).toBeNull();

    const res = await adminGql(
      `mutation { createGlobalCustomModel(input: { providerId: "507f1f77bcf86cd799439011", name: "x" }) { id } }`,
      undefined,
      userToken,
    );
    expect(res.errors).toBeDefined();
    expect(res.errors![0].message).toBe('Not authenticated');
    expect(res.errors![0].extensions?.code).toBe('UNAUTHENTICATED');
  });

  it.skipIf(!process.env.MONGODB_URI)(
    'T-A7: blocks business queries/mutations while mustChangePassword=true (MUST_CHANGE_PASSWORD)',
    async () => {
      await ensureAdminLogin();
      const supported = await setAdminMustChangePassword(true);
      expect(supported).toBe(true);

      try {
        const login = await adminGql<{ adminLogin: { token: string; admin: { mustChangePassword: boolean } } }>(
          LOGIN,
          { username: 'admin', password: ADMIN_TEST_PASSWORD },
        );
        expect(login.errors).toBeUndefined();
        expect(login.data!.adminLogin.admin.mustChangePassword).toBe(true);
        const token = login.data!.adminLogin.token;

        // 白名单放行
        const me = await adminGql<{ adminMe: { mustChangePassword: boolean } }>(ADMIN_ME, undefined, token);
        expect(me.data!.adminMe.mustChangePassword).toBe(true);

        // 业务查询被拦截
        const blocked = await adminGql(
          `query { adminProviders { id } }`,
          undefined,
          token,
        );
        expect(blocked.errors).toBeDefined();
        expect(blocked.errors![0].message).toBe('MUST_CHANGE_PASSWORD');
        expect(blocked.errors![0].extensions?.code).toBe('MUST_CHANGE_PASSWORD');
      } finally {
        await setAdminMustChangePassword(false);
      }
    },
  );

  it('should reject wrong password without leaking account existence (T-A3)', async () => {
    const body = await adminGql(LOGIN, { username: 'admin', password: 'definitely-wrong-password' });
    expect(body.errors).toBeDefined();
    expect(body.errors![0].message).toBe('Invalid username or password');
  });

  it('should login with the normalized password', async () => {
    const body = await adminGql<{ adminLogin: { token: string; admin: { mustChangePassword: boolean } } }>(
      LOGIN,
      { username: 'admin', password: ADMIN_TEST_PASSWORD },
    );
    expect(body.errors).toBeUndefined();
    expect(body.data!.adminLogin.token).toBeTruthy();
    expect(body.data!.adminLogin.admin.mustChangePassword).toBe(false);
  });

  it('should reject a too-short new password (T-A5)', async () => {
    const token = await ensureAdminLogin();
    const body = await adminGql(CHANGE_PASSWORD, {
      oldPassword: ADMIN_TEST_PASSWORD,
      newPassword: 'short',
    }, token);
    expect(body.errors).toBeDefined();
  });

  it('should reject password change with a wrong old password', async () => {
    const token = await ensureAdminLogin();
    const body = await adminGql(CHANGE_PASSWORD, {
      oldPassword: 'wrong-old-password',
      newPassword: 'AnotherStrongPass123',
    }, token);
    expect(body.errors).toBeDefined();
  });

  it('should change password, invalidate the old password and old token, and sign a new token (T-A4 / 问题 6)', async () => {
    const token = await ensureAdminLogin();
    const newPassword = 'RotatedStrongPass123';

    const changed = await adminGql<{ changeAdminPassword: { token: string; admin: { mustChangePassword: boolean } } }>(
      CHANGE_PASSWORD,
      { oldPassword: ADMIN_TEST_PASSWORD, newPassword },
      token,
    );
    expect(changed.errors).toBeUndefined();
    expect(changed.data!.changeAdminPassword.admin.mustChangePassword).toBe(false);
    expect(changed.data!.changeAdminPassword.token).toBeTruthy();

    // 旧密码失效
    const oldLogin = await adminGql(LOGIN, { username: 'admin', password: ADMIN_TEST_PASSWORD });
    expect(oldLogin.errors).toBeDefined();

    // 新密码可登录
    const newLogin = await adminGql(LOGIN, { username: 'admin', password: newPassword });
    expect(newLogin.errors).toBeUndefined();

    // 旧 token 立即失效（问题 6）：改密前签发的 token 不再通过认证
    const staleMe = await adminGql(ADMIN_ME, undefined, token);
    expect(staleMe.data?.adminMe ?? null).toBeNull();

    // 改密返回的新 token 仍有效
    const freshMe = await adminGql<{ adminMe: { username: string } }>(
      ADMIN_ME,
      undefined,
      changed.data!.changeAdminPassword.token,
    );
    expect(freshMe.errors).toBeUndefined();
    expect(freshMe.data!.adminMe.username).toBe('admin');

    // 还原，避免影响其它套件
    const restore = await adminGql(CHANGE_PASSWORD, {
      oldPassword: newPassword,
      newPassword: ADMIN_TEST_PASSWORD,
    }, changed.data!.changeAdminPassword.token);
    expect(restore.errors).toBeUndefined();
  });

  it('should not expose any signup/register mutation (T-F7 / no self-service)', async () => {
    const res = await adminGql<{ __schema: { mutationType: { fields: Array<{ name: string }> } } }>(INTROSPECTION);
    const names = res.data!.__schema.mutationType.fields.map((f) => f.name.toLowerCase());
    expect(names.some((n) => n.includes('signup') || n.includes('register'))).toBe(false);
    expect(names).toContain('adminlogin');
  });

  it('should return UNAUTHENTICATED for business mutation without token (T-A6)', async () => {
    const res = await adminGqlRequest(
      `mutation { createGlobalCustomModel(input: { providerId: "000000000000000000000000", name: "x" }) { id } }`,
    );
    const body = await res.json();
    expect(body.errors).toBeDefined();
    expect(body.errors[0].message).toBe('Not authenticated');
  });
});
