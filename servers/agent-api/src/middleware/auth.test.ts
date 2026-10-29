import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  user: { findById: vi.fn() },
  workspace: { findById: vi.fn(), findOne: vi.fn() },
  tenantMember: { findOne: vi.fn() },
  workspaceMember: { findOne: vi.fn() },
  verifyToken: vi.fn(),
}));

vi.mock('../models/user.js', () => ({ User: h.user }));
vi.mock('../models/workspace.js', () => ({ Workspace: h.workspace }));
vi.mock('../models/tenant-member.js', () => ({ TenantMember: h.tenantMember }));
vi.mock('../models/workspace-member.js', () => ({ WorkspaceMember: h.workspaceMember }));
vi.mock('../services/auth.js', () => ({ verifyToken: h.verifyToken }));

import { resolveWorkspaceAccess, type AuthenticatedUser } from './auth.js';

const USER: AuthenticatedUser = { id: '507f1f77bcf86cd799439001', tenantId: '507f1f77bcf86cd799439002', name: 'u' };
const WS_NORMAL = '507f1f77bcf86cd799439011';
const WS_GLOBAL = '507f1f77bcf86cd799439012';
const TENANT = '507f1f77bcf86cd799439002';

function lean(value: unknown) {
  return { lean: async () => value, select: () => lean(value) };
}
function request(headers: Record<string, string> = {}) {
  return new Request('http://localhost/graphql', { headers });
}

describe('resolveWorkspaceAccess（T-CTX）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-CTX1: 缺省/缺头回退个人租户全局工作区（role=admin，readOnly=false）', async () => {
    h.workspace.findOne.mockReturnValue(lean({ _id: WS_GLOBAL, tenantId: TENANT }));
    const access = await resolveWorkspaceAccess(request(), USER);
    expect(access).toMatchObject({
      id: WS_GLOBAL,
      tenantId: TENANT,
      type: 'global',
      role: 'admin',
      readOnly: false,
      globalWorkspaceId: WS_GLOBAL,
    });
  });

  it('T-CTX2: admin 直通任意工作区', async () => {
    h.workspace.findById.mockReturnValue(lean({ _id: WS_NORMAL, tenantId: TENANT, type: 'normal' }));
    h.tenantMember.findOne.mockReturnValue(lean({ role: 'admin' }));
    h.workspace.findOne.mockReturnValue(lean({ _id: WS_GLOBAL }));

    const access = await resolveWorkspaceAccess(request({ 'x-workspace-id': WS_NORMAL }), USER);
    expect(access).toMatchObject({ id: WS_NORMAL, type: 'normal', role: 'admin', readOnly: false, globalWorkspaceId: WS_GLOBAL });
    expect(h.workspaceMember.findOne).not.toHaveBeenCalled();
  });

  it('T-CTX3: developer 普通工作区需 workspacemembers 成员；非成员 workspace not found', async () => {
    h.workspace.findById.mockReturnValue(lean({ _id: WS_NORMAL, tenantId: TENANT, type: 'normal' }));
    h.tenantMember.findOne.mockReturnValue(lean({ role: 'developer' }));
    h.workspace.findOne.mockReturnValue(lean({ _id: WS_GLOBAL }));
    h.workspaceMember.findOne.mockReturnValue(lean({ _id: 'm' }));
    const access = await resolveWorkspaceAccess(request({ 'x-workspace-id': WS_NORMAL }), USER);
    expect(access).toMatchObject({ role: 'developer', readOnly: false });

    h.workspaceMember.findOne.mockReturnValue(lean(null));
    await expect(resolveWorkspaceAccess(request({ 'x-workspace-id': WS_NORMAL }), USER)).rejects.toThrow(
      'workspace not found',
    );
  });

  it('T-CTX4: developer 全局工作区 readOnly=true', async () => {
    h.workspace.findById.mockReturnValue(lean({ _id: WS_GLOBAL, tenantId: TENANT, type: 'global' }));
    h.tenantMember.findOne.mockReturnValue(lean({ role: 'developer' }));
    h.workspace.findOne.mockReturnValue(lean({ _id: WS_GLOBAL }));
    const access = await resolveWorkspaceAccess(request({ 'x-workspace-id': WS_GLOBAL }), USER);
    expect(access).toMatchObject({ type: 'global', role: 'developer', readOnly: true });
  });

  it('T-CTX5: 非本租户成员 / 不存在的工作区一律 workspace not found', async () => {
    h.workspace.findById.mockReturnValue(lean(null));
    await expect(resolveWorkspaceAccess(request({ 'x-workspace-id': WS_NORMAL }), USER)).rejects.toThrow(
      'workspace not found',
    );

    h.workspace.findById.mockReturnValue(lean({ _id: WS_NORMAL, tenantId: TENANT, type: 'normal' }));
    h.tenantMember.findOne.mockReturnValue(lean(null));
    await expect(resolveWorkspaceAccess(request({ 'x-workspace-id': WS_NORMAL }), USER)).rejects.toThrow(
      'workspace not found',
    );
  });

  it('T-CTX6: 半迁移缺全局工作区时返回 undefined（保持一期行为）', async () => {
    h.workspace.findOne.mockReturnValue(lean(null));
    expect(await resolveWorkspaceAccess(request(), USER)).toBeUndefined();
  });
});
