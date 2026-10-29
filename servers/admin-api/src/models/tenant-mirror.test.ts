import { describe, it, expect } from 'vitest';
import { TenantMember } from './tenant-member.js';
import { Workspace } from './workspace.js';
import { WorkspaceMember } from './workspace-member.js';
import { Provider } from './provider.js';
import { Model } from './model.js';

/**
 * 多租户二期 admin-api 只读镜像的集合名与索引声明（F10）。
 *
 * 索引声明必须与 agent-api 迁移 015 切换后的形态逐字一致（同 key + 同 options + 同 name），
 * 否则 admin-api `autoIndex` 会复活旧 `{scope,name}` 唯一索引导致迁移复制/写入失败。
 */
function indexEntries(model: { schema: { indexes(): Array<[Record<string, unknown>, Record<string, unknown>]> } }) {
  return model.schema.indexes();
}

function findIndex(
  model: { schema: { indexes(): Array<[Record<string, unknown>, Record<string, unknown>]> } },
  options: Record<string, unknown>,
) {
  return indexEntries(model).find(([, opts]) => opts.name === options.name);
}

describe('多租户二期只读镜像（集合名 + 索引声明）', () => {
  it('tenantmembers/workspaces/workspacemembers 集合名与唯一索引', () => {
    expect(TenantMember.collection.name).toBe('tenantmembers');
    expect(Workspace.collection.name).toBe('workspaces');
    expect(WorkspaceMember.collection.name).toBe('workspacemembers');

    const tenantMemberUnique = indexEntries(TenantMember).find(([, opts]) => opts.unique === true);
    expect(tenantMemberUnique?.[0]).toEqual({ tenantId: 1, userId: 1 });

    const workspaceNameUnique = indexEntries(Workspace).find(
      ([fields, opts]) =>
        opts.unique === true && (fields as Record<string, unknown>).name === 1 && !opts.partialFilterExpression,
    );
    expect(workspaceNameUnique?.[0]).toEqual({ tenantId: 1, name: 1 });

    const globalWorkspaceUnique = findIndex(Workspace, { name: 'uniq_global_workspace_per_tenant' });
    expect(globalWorkspaceUnique?.[0]).toEqual({ tenantId: 1 });
    expect(globalWorkspaceUnique?.[1]).toMatchObject({
      unique: true,
      partialFilterExpression: { type: 'global' },
    });

    const workspaceMemberUnique = indexEntries(WorkspaceMember).find(([, opts]) => opts.unique === true);
    expect(workspaceMemberUnique?.[0]).toEqual({ workspaceId: 1, userId: 1 });
  });

  it('providers：旧 {scope,name} 唯一声明已删除，切 user 域 {tenantId,workspaceId,name} + global 域 {name}', () => {
    const entries = indexEntries(Provider);

    const legacy = entries.find(
      ([fields]) =>
        (fields as Record<string, unknown>).scope === 1 && (fields as Record<string, unknown>).name === 1,
    );
    expect(legacy).toBeUndefined();

    const userDomain = findIndex(Provider, { name: 'uniq_provider_tenant_workspace_name' });
    expect(userDomain?.[0]).toEqual({ tenantId: 1, workspaceId: 1, name: 1 });
    expect(userDomain?.[1]).toMatchObject({
      unique: true,
      partialFilterExpression: { scope: 'user' },
    });

    const globalDomain = findIndex(Provider, { name: 'uniq_provider_global_name' });
    expect(globalDomain?.[0]).toEqual({ name: 1 });
    expect(globalDomain?.[1]).toMatchObject({
      unique: true,
      partialFilterExpression: { scope: 'global' },
    });
  });

  it('models：补 {tenantId,workspaceId} 非唯一索引（与迁移 015 固定名一致）', () => {
    const workspaceIndex = findIndex(Model, { name: 'tenantId_1_workspaceId_1' });
    expect(workspaceIndex?.[0]).toEqual({ tenantId: 1, workspaceId: 1 });
    expect(workspaceIndex?.[1].unique).toBeFalsy();
  });
});
