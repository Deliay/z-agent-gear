import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/workspace-service.js', () => ({
  workspaceService: {
    accessibleWorkspaces: vi.fn(),
    workspaceFacets: vi.fn(),
  },
}));
vi.mock('../../models/tenant.js', () => ({
  Tenant: { find: vi.fn() },
}));
vi.mock('../../services/tenant-member-service.js', () => ({
  tenantMemberService: {},
}));

import { buildWorkspaceContext } from './workspace.js';
import { workspaceService } from '../../services/workspace-service.js';
import { Tenant } from '../../models/tenant.js';

const ctx = { currentUser: { id: 'user-1' } } as never;

describe('buildWorkspaceContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspaceService.accessibleWorkspaces).mockResolvedValue([
      {
        workspace: { _id: 'ws-global', name: '全局', type: 'global', tenantId: 'tenant-1', createdAt: new Date() },
        tenantName: 't',
        role: 'admin',
      },
      {
        workspace: { _id: 'ws-normal', name: '项目', type: 'normal', tenantId: 'tenant-1', createdAt: new Date() },
        tenantName: 't',
        role: 'admin',
      },
    ] as never);
    vi.mocked(workspaceService.workspaceFacets).mockResolvedValue({
      tenant: { id: 'tenant-1', name: 't', type: 'team' },
      memberCount: 2,
      myRole: 'admin',
      readOnly: false,
    } as never);
    vi.mocked(Tenant.find).mockReturnValue({
      lean: vi.fn().mockResolvedValue([
        { _id: 'tenant-1', name: 't', type: 'team' },
      ]),
    } as never);
  });

  it('单次 accessibleWorkspaces 同时产出 myWorkspaces / myTenants（T-WCTX1）', async () => {
    const result = await buildWorkspaceContext('user-1', ctx);

    expect(workspaceService.accessibleWorkspaces).toHaveBeenCalledTimes(1);
    expect(result.myWorkspaces.map((workspace) => workspace.id)).toEqual(['ws-global', 'ws-normal']);
    expect(result.myTenants).toEqual([
      {
        tenant: { id: 'tenant-1', name: 't', type: 'team', memberCount: 0 },
        role: 'admin',
      },
    ]);
  });
});
