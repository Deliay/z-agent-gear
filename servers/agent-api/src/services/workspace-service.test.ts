import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Tenant } from './../models/tenant.js';
import { User } from './../models/user.js';
import { Account } from './../models/account.js';
import { Workspace } from './../models/workspace.js';
import { TenantMember } from './../models/tenant-member.js';
import { WorkspaceMember } from './../models/workspace-member.js';
import { Session } from './../models/session.js';
import { WorkflowInstance } from './../models/workflow-instance.js';
import { workspaceService, WORKSPACE_ERRORS } from './workspace-service.js';
import { runWithWorkspace } from './workspace-context.js';
import { tenantMemberService } from './tenant-member-service.js';

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri('agent-api-workspace-service-test'));
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
});

async function createUser(username: string) {
  const account = await Account.create({ username, passwordHash: 'hash' });
  return User.create({
    username,
    passwordHash: 'hash',
    name: username,
    accountId: account._id,
  });
}

async function createTeam(name: string) {
  return Tenant.create({ name, type: 'team' });
}

async function createPersonal(name: string) {
  return Tenant.create({ name, type: 'personal' });
}

describe('WorkspaceService（T-WSP，真库）', () => {
  it('T-WSP0: 错误文案白名单 15 条逐字锚定', () => {
    expect(WORKSPACE_ERRORS).toEqual({
      notFound: 'workspace not found',
      nameExists: 'workspace name already exists',
      globalImmutable: 'global workspace is immutable',
      readOnly: 'global workspace is read-only',
      personalCreate: 'personal tenant cannot create workspaces',
      personalImmutable: 'personal tenant is immutable',
      notEmpty: 'workspace is not empty',
      notMember: 'not a workspace member',
      notAdmin: 'not a tenant admin',
      notTenantMember: 'user is not a tenant member',
      accountNotFound: 'account not found',
      alreadyMember: 'already a member',
      notMemberRow: 'not a member',
      lastAdminRemoved: 'last admin cannot be removed',
      lastAdminDemoted: 'last admin cannot be demoted',
    });
  });

  it('T-WSP1: ensureGlobalWorkspace 幂等 + 写入 admin 成员行', async () => {
    const tenant = await createTeam('team-a');
    const user = await createUser('alice');
    const first = await workspaceService.ensureGlobalWorkspace(String(tenant._id), {
      adminUserId: String(user._id),
    });
    const second = await workspaceService.ensureGlobalWorkspace(String(tenant._id), {
      adminUserId: String(user._id),
    });
    expect(second.id).toBe(first.id);
    expect(first.name).toBe('全局工作区');
    expect(await Workspace.countDocuments({ tenantId: tenant._id, type: 'global' })).toBe(1);
    const membership = await TenantMember.findOne({ tenantId: tenant._id, userId: user._id }).lean();
    expect(membership).toMatchObject({ role: 'admin', createdBy: 'provision' });
  });

  it('T-WSP2: createWorkspace 仅 team admin；personal 拒绝；重名拒绝', async () => {
    const personal = await createPersonal('p1');
    const user = await createUser('bob');
    await expect(
      workspaceService.createWorkspace(String(user._id), String(personal._id), 'w1'),
    ).rejects.toThrow(WORKSPACE_ERRORS.personalCreate);

    const team = await createTeam('team-b');
    await TenantMember.create({ tenantId: team._id, userId: user._id, role: 'developer' });
    await expect(
      workspaceService.createWorkspace(String(user._id), String(team._id), 'w1'),
    ).rejects.toThrow(WORKSPACE_ERRORS.notAdmin);

    await TenantMember.updateOne({ tenantId: team._id, userId: user._id }, { $set: { role: 'admin' } });
    const created = await workspaceService.createWorkspace(String(user._id), String(team._id), 'w1');
    expect(created).toMatchObject({ name: 'w1', type: 'normal' });
    await expect(
      workspaceService.createWorkspace(String(user._id), String(team._id), 'w1'),
    ).rejects.toThrow(WORKSPACE_ERRORS.nameExists);
  });

  it('T-WSP3: global 不可改名/删除/加成员', async () => {
    const tenant = await createTeam('team-c');
    const user = await createUser('carol');
    const global = await workspaceService.ensureGlobalWorkspace(String(tenant._id), {
      adminUserId: String(user._id),
    });
    await expect(
      workspaceService.renameWorkspace(String(user._id), global.id, 'x'),
    ).rejects.toThrow(WORKSPACE_ERRORS.globalImmutable);
    await expect(workspaceService.deleteWorkspace(String(user._id), global.id)).rejects.toThrow(
      WORKSPACE_ERRORS.globalImmutable,
    );
    await expect(
      workspaceService.addWorkspaceMember(String(user._id), global.id, String(user._id)),
    ).rejects.toThrow(WORKSPACE_ERRORS.globalImmutable);
  });

  it('T-WSP4: 删除保护（10 集合任一持有资源即拒绝；Commit 设置已成员级不再计入）', async () => {
    const tenant = await createTeam('team-d');
    const user = await createUser('dave');
    await TenantMember.create({ tenantId: tenant._id, userId: user._id, role: 'admin' });
    const workspace = await workspaceService.createWorkspace(
      String(user._id),
      String(tenant._id),
      'busy',
    );
    await mongoose.connection.collection('sessions').insertOne({
      userId: user._id,
      tenantId: tenant._id,
      workspaceId: new mongoose.Types.ObjectId(workspace.id),
      controllerId: new mongoose.Types.ObjectId(),
      controllerName: 'c',
      acpServerType: 'opencode',
    });
    await expect(workspaceService.deleteWorkspace(String(user._id), workspace.id)).rejects.toThrow(
      WORKSPACE_ERRORS.notEmpty,
    );
    await Session.deleteMany({});
    expect(await workspaceService.deleteWorkspace(String(user._id), workspace.id)).toBe(true);
  });

  it('T-WSP5: 成员须为本租户成员；移除非成员报错；无认领路径', async () => {
    const tenant = await createTeam('team-e');
    const admin = await createUser('erin');
    const developer = await createUser('frank');
    const outsider = await createUser('grace');
    await TenantMember.create({ tenantId: tenant._id, userId: admin._id, role: 'admin' });
    await TenantMember.create({ tenantId: tenant._id, userId: developer._id, role: 'developer' });
    const workspace = await workspaceService.createWorkspace(
      String(admin._id),
      String(tenant._id),
      'w-e',
    );

    await expect(
      workspaceService.addWorkspaceMember(String(admin._id), workspace.id, String(outsider._id)),
    ).rejects.toThrow(WORKSPACE_ERRORS.notTenantMember);
    await workspaceService.addWorkspaceMember(String(admin._id), workspace.id, String(developer._id));
    expect(await WorkspaceMember.countDocuments({ workspaceId: workspace.id })).toBe(1);
    await expect(
      workspaceService.removeWorkspaceMember(String(admin._id), workspace.id, String(outsider._id)),
    ).rejects.toThrow(WORKSPACE_ERRORS.notMemberRow);
  });

  it('T-WSP6: accessibleWorkspaces —— admin 全部 / developer global+已加入', async () => {
    const team = await createTeam('team-f');
    const admin = await createUser('henry');
    const developer = await createUser('ivy');
    await TenantMember.create({ tenantId: team._id, userId: admin._id, role: 'admin' });
    await TenantMember.create({ tenantId: team._id, userId: developer._id, role: 'developer' });
    const global = await workspaceService.ensureGlobalWorkspace(String(team._id));
    const w1 = await workspaceService.createWorkspace(String(admin._id), String(team._id), 'w1');
    const w2 = await workspaceService.createWorkspace(String(admin._id), String(team._id), 'w2');
    await WorkspaceMember.create({
      workspaceId: new mongoose.Types.ObjectId(w1.id),
      tenantId: team._id,
      userId: developer._id,
    });

    const adminWorkspaces = await workspaceService.accessibleWorkspaces(String(admin._id));
    expect(adminWorkspaces.map((item) => item.workspace.name).sort()).toEqual(
      ['w1', 'w2', '全局工作区'].sort(),
    );

    const developerWorkspaces = await workspaceService.accessibleWorkspaces(String(developer._id));
    expect(developerWorkspaces.map((item) => item.workspace.name).sort()).toEqual(
      ['w1', '全局工作区'].sort(),
    );
    expect(developerWorkspaces.find((item) => item.workspace.type === 'global')?.role).toBe(
      'developer',
    );
    expect(global.id).toBeTruthy();
  });
});

describe('TenantMemberService（T-TM，真库）', () => {
  it('T-TM1: searchAccounts 仅 team admin 可调用，结果最小集', async () => {
    const team = await createTeam('team-g');
    const admin = await createUser('judy');
    const developer = await createUser('kate');
    await createUser('kenny');
    await TenantMember.create({ tenantId: team._id, userId: admin._id, role: 'admin' });
    await TenantMember.create({ tenantId: team._id, userId: developer._id, role: 'developer' });

    await expect(tenantMemberService.searchAccounts(String(developer._id), 'ke')).rejects.toThrow(
      WORKSPACE_ERRORS.notAdmin,
    );
    const rows = await tenantMemberService.searchAccounts(String(admin._id), 'k');
    expect(rows.map((row) => row.username).sort()).toEqual(['kenny', 'kate'].sort());
    expect(Object.keys(rows[0]).sort()).toEqual(['name', 'userId', 'username']);
  });

  it('T-TM2: addTenantMember 指定/缺省角色；重复幂等不覆盖角色；personal 拒绝', async () => {
    const team = await createTeam('team-h');
    const admin = await createUser('laura');
    const target = await createUser('mike');
    await TenantMember.create({ tenantId: team._id, userId: admin._id, role: 'admin' });

    const added = await tenantMemberService.addTenantMember(
      String(admin._id),
      String(team._id),
      'mike',
      'admin',
    );
    expect(added.role).toBe('admin');
    const again = await tenantMemberService.addTenantMember(
      String(admin._id),
      String(team._id),
      'mike',
      'developer',
    );
    expect(again.role).toBe('admin');
    expect(await TenantMember.countDocuments({ tenantId: team._id })).toBe(2);

    const other = await createUser('nina');
    const defaulted = await tenantMemberService.addTenantMember(
      String(admin._id),
      String(team._id),
      'nina',
    );
    expect(defaulted.role).toBe('developer');
    expect(String(other._id)).toBe(defaulted.id);

    const personal = await createPersonal('mike');
    await expect(
      tenantMemberService.addTenantMember(String(admin._id), String(personal._id), 'nina'),
    ).rejects.toThrow(WORKSPACE_ERRORS.personalImmutable);
  });

  it('T-TM3: last-admin 移除/降级拒绝；移除级联清理 workspacemembers、资源保留', async () => {
    const team = await createTeam('team-i');
    const admin = await createUser('olivia');
    const developer = await createUser('peter');
    await TenantMember.create({ tenantId: team._id, userId: admin._id, role: 'admin' });
    await TenantMember.create({ tenantId: team._id, userId: developer._id, role: 'developer' });
    const workspace = await workspaceService.createWorkspace(
      String(admin._id),
      String(team._id),
      'w-i',
    );
    await WorkspaceMember.create({
      workspaceId: new mongoose.Types.ObjectId(workspace.id),
      tenantId: team._id,
      userId: developer._id,
    });
    await mongoose.connection.collection('sessions').insertOne({
      userId: developer._id,
      tenantId: team._id,
      workspaceId: new mongoose.Types.ObjectId(workspace.id),
      controllerId: new mongoose.Types.ObjectId(),
      controllerName: 'c',
      acpServerType: 'opencode',
    });

    await expect(
      tenantMemberService.removeTenantMember(String(admin._id), String(team._id), String(admin._id)),
    ).rejects.toThrow(WORKSPACE_ERRORS.lastAdminRemoved);
    await expect(
      tenantMemberService.changeTenantMemberRole(
        String(admin._id),
        String(team._id),
        String(admin._id),
        'developer',
      ),
    ).rejects.toThrow(WORKSPACE_ERRORS.lastAdminDemoted);

    expect(
      await tenantMemberService.removeTenantMember(
        String(admin._id),
        String(team._id),
        String(developer._id),
      ),
    ).toBe(true);
    expect(await TenantMember.countDocuments({ tenantId: team._id, userId: developer._id })).toBe(0);
    expect(await WorkspaceMember.countDocuments({ userId: developer._id })).toBe(0);
    // 资源保留原工作区
    expect(
      await mongoose.connection.collection('sessions').countDocuments({ userId: developer._id }),
    ).toBe(1);
    // 重新加入不自动恢复工作区成员
    await tenantMemberService.addTenantMember(
      String(admin._id),
      String(team._id),
      'peter',
      'developer',
    );
    expect(await WorkspaceMember.countDocuments({ userId: developer._id })).toBe(0);
  });

  it('T-TM4: 角色变更成功且写审计（createdBy=operator）', async () => {
    const team = await createTeam('team-j');
    const admin = await createUser('quinn');
    const developer = await createUser('rose');
    await TenantMember.create({ tenantId: team._id, userId: admin._id, role: 'admin' });
    await TenantMember.create({ tenantId: team._id, userId: developer._id, role: 'developer' });

    const changed = await tenantMemberService.changeTenantMemberRole(
      String(admin._id),
      String(team._id),
      String(developer._id),
      'admin',
    );
    expect(changed.role).toBe('admin');
    const row = await TenantMember.findOne({ tenantId: team._id, userId: developer._id }).lean();
    expect(row?.createdBy).toBe(String(admin._id));
  });

  it('T-TM5: 并发 upsert E11000 → already a member（唯一索引翻译）', async () => {
    const team = await createTeam('team-k');
    const admin = await createUser('sam');
    await createUser('tina');
    await TenantMember.create({ tenantId: team._id, userId: admin._id, role: 'admin' });

    const spy = vi.spyOn(TenantMember, 'create').mockRejectedValueOnce(
      Object.assign(new Error('E11000 duplicate key'), { code: 11000 }),
    );
    await expect(
      tenantMemberService.addTenantMember(String(admin._id), String(team._id), 'tina', 'developer'),
    ).rejects.toThrow(WORKSPACE_ERRORS.alreadyMember);
    spy.mockRestore();
  });
});

describe('WorkspaceService.systemWorkspaceContext（团队租户，真库）', () => {
  it('T-WSP-SYS1: 构造 admin/非只读上下文，团队实例查询在上下文内可见', async () => {
    const team = await createTeam('sys-team');
    const user = await createUser('sys-user');
    const global = await Workspace.create({ tenantId: team._id, name: '全局工作区', type: 'global' });
    const normal = await Workspace.create({ tenantId: team._id, name: '项目', type: 'normal' });
    const instanceId = new mongoose.Types.ObjectId();
    await WorkflowInstance.collection.insertOne({
      _id: instanceId,
      userId: user._id,
      tenantId: team._id,
      controllerId: new mongoose.Types.ObjectId(),
      workspaceId: new mongoose.Types.ObjectId(),
      resourceWorkspaceId: normal._id,
      configuredWorkflowId: new mongoose.Types.ObjectId(),
      name: 'wf',
      nodes: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // 无上下文：tenant-scope 注入 tenantId=userId，团队实例（tenantId=team）查不到
    expect(await WorkflowInstance.findOne({ _id: instanceId, userId: user._id }).lean()).toBeNull();

    const context = await workspaceService.systemWorkspaceContext(String(normal._id));
    expect(context).toMatchObject({
      id: String(normal._id),
      tenantId: String(team._id),
      type: 'normal',
      role: 'admin',
      readOnly: false,
      globalWorkspaceId: String(global._id),
    });

    const found = await runWithWorkspace(
      context,
      async () => WorkflowInstance.findOne({ _id: instanceId, userId: user._id }).lean(),
    );
    expect(found).not.toBeNull();
  }, 20_000);

  it('T-WSP-SYS2: 非法/不存在的工作区 id 返回 undefined', async () => {
    await expect(workspaceService.systemWorkspaceContext('not-an-id')).resolves.toBeUndefined();
    await expect(
      workspaceService.systemWorkspaceContext(String(new mongoose.Types.ObjectId())),
    ).resolves.toBeUndefined();
  }, 20_000);
});
