import { describe, it, expect } from 'vitest';
import {
  defaultPermissionMode,
  resolveKnowledgeBaseAccess,
} from './knowledge-base-access.js';
import type { WorkspaceContext } from './workspace-context.js';

/**
 * T-KBA1~8：权限矩阵纯函数（四档模式 × admin/developer × 本工作区/全局/跨工作区）。
 * 唯一事实源锁定：全局工作区 developer（readOnly 上下文）访问全局库按库模式放行写（D2/T-KBA8）。
 */

const TENANT = 'tenant-1';
const WS_A = 'ws-a';
const WS_B = 'ws-b';
const WS_GLOBAL = 'ws-global';

const adminA: WorkspaceContext = {
  id: WS_A,
  tenantId: TENANT,
  type: 'normal',
  role: 'admin',
  readOnly: false,
  globalWorkspaceId: WS_GLOBAL,
};
const devA: WorkspaceContext = { ...adminA, role: 'developer' };
const devGlobal: WorkspaceContext = {
  id: WS_GLOBAL,
  tenantId: TENANT,
  type: 'global',
  role: 'developer',
  readOnly: true,
  globalWorkspaceId: WS_GLOBAL,
};

const MODES = ['NONE', 'READ_ONLY', 'UPDATE_ONLY', 'FULL_ACCESS'] as const;

function kb(workspaceId: string, permissionMode: (typeof MODES)[number]) {
  return { workspaceId, permissionMode };
}

describe('knowledge-base-access 权限矩阵（T-KBA）', () => {
  it('T-KBA1: admin × 四模式 × 本工作区/全局库 → 六项全 true', () => {
    for (const workspaceId of [WS_A, WS_GLOBAL]) {
      for (const mode of MODES) {
        const access = resolveKnowledgeBaseAccess(kb(workspaceId, mode), adminA);
        expect(access).toEqual({
          visible: true,
          canRead: true,
          canCreate: true,
          canUpdate: true,
          canDelete: true,
          canManage: true,
        });
      }
    }
  });

  it('T-KBA2: NONE + developer → visible=false（本工作区与全局库同口径）', () => {
    for (const workspaceId of [WS_A, WS_GLOBAL]) {
      const access = resolveKnowledgeBaseAccess(kb(workspaceId, 'NONE'), devA);
      expect(access.visible).toBe(false);
      expect(access).toEqual({
        visible: false,
        canRead: false,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
        canManage: false,
      });
    }
  });

  it('T-KBA3: READ_ONLY + developer → 仅 canRead', () => {
    const access = resolveKnowledgeBaseAccess(kb(WS_A, 'READ_ONLY'), devA);
    expect(access).toEqual({
      visible: true,
      canRead: true,
      canCreate: false,
      canUpdate: false,
      canDelete: false,
      canManage: false,
    });
  });

  it('T-KBA4: UPDATE_ONLY + developer → canRead/canCreate/canUpdate、不可删', () => {
    const access = resolveKnowledgeBaseAccess(kb(WS_A, 'UPDATE_ONLY'), devA);
    expect(access).toEqual({
      visible: true,
      canRead: true,
      canCreate: true,
      canUpdate: true,
      canDelete: false,
      canManage: false,
    });
  });

  it('T-KBA5: FULL_ACCESS + developer → 仅 canManage=false', () => {
    const access = resolveKnowledgeBaseAccess(kb(WS_A, 'FULL_ACCESS'), devA);
    expect(access).toEqual({
      visible: true,
      canRead: true,
      canCreate: true,
      canUpdate: true,
      canDelete: true,
      canManage: false,
    });
  });

  it('T-KBA6: 库属其他普通工作区（非 ctx.id/globalWorkspaceId）→ visible=false', () => {
    for (const mode of MODES) {
      const access = resolveKnowledgeBaseAccess(kb(WS_B, mode), adminA);
      expect(access.visible).toBe(false);
    }
  });

  it('T-KBA7: defaultPermissionMode：global → READ_ONLY、normal → NONE', () => {
    expect(defaultPermissionMode('global')).toBe('READ_ONLY');
    expect(defaultPermissionMode('normal')).toBe('NONE');
  });

  it('T-KBA8: 全局工作区 developer（readOnly）访问全局库按库模式放行写', () => {
    expect(devGlobal.readOnly).toBe(true);
    const updateOnly = resolveKnowledgeBaseAccess(kb(WS_GLOBAL, 'UPDATE_ONLY'), devGlobal);
    expect(updateOnly.canUpdate).toBe(true);
    expect(updateOnly.canCreate).toBe(true);
    expect(updateOnly.canDelete).toBe(false);

    const full = resolveKnowledgeBaseAccess(kb(WS_GLOBAL, 'FULL_ACCESS'), devGlobal);
    expect(full.canDelete).toBe(true);
    expect(full.canManage).toBe(false);

    const readOnly = resolveKnowledgeBaseAccess(kb(WS_GLOBAL, 'READ_ONLY'), devGlobal);
    expect(readOnly.canRead).toBe(true);
    expect(readOnly.canUpdate).toBe(false);
  });
});
