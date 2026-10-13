import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/controller.js', () => ({
  controllerService: { findAllByUser: vi.fn() },
}));

vi.mock('../../services/controller-workspace.js', () => ({
  controllerWorkspaceService: { findAllByUser: vi.fn() },
}));

vi.mock('../../services/session.js', () => ({
  sessionService: { findAllByUser: vi.fn() },
}));

vi.mock('../../services/workflow/instance.js', () => ({
  workflowInstanceService: { list: vi.fn() },
}));

vi.mock('../../services/todo-service.js', () => ({
  todoService: { getTodoList: vi.fn(), getUnreadTodoCount: vi.fn() },
}));

vi.mock('../../services/gateway.js', () => ({
  gatewayService: { findAllByController: vi.fn() },
}));

vi.mock('../../services/worktree.js', () => ({
  worktreeService: { list: vi.fn() },
}));

import { homeResolvers } from './home.js';
import { controllerService } from '../../services/controller.js';
import { controllerWorkspaceService } from '../../services/controller-workspace.js';
import { sessionService } from '../../services/session.js';
import { workflowInstanceService } from '../../services/workflow/instance.js';
import { todoService } from '../../services/todo-service.js';
import { gatewayService } from '../../services/gateway.js';
import { worktreeService } from '../../services/worktree.js';

const ctx = { currentUser: { id: 'user-1', username: 'u' } } as never;
const emptyCtx = { currentUser: null } as never;

function oid(id: string) {
  return { toString: () => id } as import('mongoose').Types.ObjectId;
}

const instanceDoc = {
  _id: oid('inst-1'),
  configuredWorkflowId: oid('cfg-1'),
  controllerId: oid('ctrl-1'),
  workspaceId: oid('ws-1'),
  name: '需求A开发',
  currentNodeNames: ['技术方案'],
  nodes: [],
  blackboard: new Map(),
  blackboardTrash: new Map(),
  blackboardUpdatedAt: new Map(),
  archivedAt: null,
  createdAt: new Date('2026-08-01'),
  updatedAt: new Date('2026-08-02'),
};

describe('home resolvers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(controllerService.findAllByUser).mockResolvedValue([
      { id: 'ctrl-1', name: '控制器1' },
    ] as never);
    vi.mocked(sessionService.findAllByUser).mockResolvedValue([
      { id: 's-1' },
      { id: 's-2' },
    ] as never);
    vi.mocked(controllerWorkspaceService.findAllByUser).mockResolvedValue([
      { id: 'ws-1', controllerId: 'ctrl-1', name: 'project' },
    ] as never);
    vi.mocked(workflowInstanceService.list).mockImplementation(
      (_userId: string, options?: { archived?: boolean }) =>
        Promise.resolve(
          (options?.archived ? [{ ...instanceDoc, _id: oid('inst-arch') }] : [instanceDoc]) as never,
        ),
    );
    vi.mocked(todoService.getTodoList).mockResolvedValue([{ id: 'todo-1' }] as never);
    vi.mocked(todoService.getUnreadTodoCount).mockResolvedValue(3 as never);
  });

  it('未认证拒绝', async () => {
    await expect(homeResolvers.Query.homeOverview({}, {}, emptyCtx)).rejects.toThrow(
      'Not authenticated',
    );
  });

  it('并行组合各信息流，sessionTotalCount 与 sessions 同口径', async () => {
    const result = await homeResolvers.Query.homeOverview({}, {}, ctx);

    expect(controllerService.findAllByUser).toHaveBeenCalledWith('user-1');
    expect(sessionService.findAllByUser).toHaveBeenCalledWith('user-1', {
      includeWorkflowSessions: false,
    });
    expect(controllerWorkspaceService.findAllByUser).toHaveBeenCalledWith('user-1');
    expect(workflowInstanceService.list).toHaveBeenCalledWith('user-1', { archived: false });
    expect(workflowInstanceService.list).toHaveBeenCalledWith('user-1', { archived: true });

    expect(result.controllers).toHaveLength(1);
    expect(result.sessions).toHaveLength(2);
    expect(result.sessionTotalCount).toBe(2);
    expect(result.workspaces).toHaveLength(1);
    expect(result.workflowInstances[0]).toMatchObject({ id: 'inst-1', name: '需求A开发' });
    expect(result.archivedWorkflowInstances[0]).toMatchObject({ id: 'inst-arch' });
    expect(result.todos).toHaveLength(1);
    expect(result.unreadTodoCount).toBe(3);
  });

  it('单分支失败降级为空值，其余信息流正常', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(workflowInstanceService.list).mockRejectedValue(new Error('mongo 挂了'));

    const result = await homeResolvers.Query.homeOverview({}, {}, ctx);

    expect(result.workflowInstances).toEqual([]);
    expect(result.archivedWorkflowInstances).toEqual([]);
    // 其余分支不受影响
    expect(result.controllers).toHaveLength(1);
    expect(result.sessionTotalCount).toBe(2);
    expect(result.unreadTodoCount).toBe(3);
  });

  it('Controller.gateways 惰性解析，失败降级为空列表', async () => {
    vi.mocked(gatewayService.findAllByController).mockResolvedValue({
      gateways: [{ id: 'gw-1' }],
      total: 1,
      limit: 10,
    } as never);

    const ok = await homeResolvers.Controller.gateways({ id: 'ctrl-1' }, {}, ctx);
    expect(ok.gateways).toHaveLength(1);
    expect(gatewayService.findAllByController).toHaveBeenCalledWith('ctrl-1', 'user-1');

    vi.mocked(gatewayService.findAllByController).mockRejectedValue(new Error('relay timeout'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const degraded = await homeResolvers.Controller.gateways({ id: 'ctrl-1' }, {}, ctx);
    expect(degraded).toEqual({ gateways: [], total: 0, limit: 0 });
  });

  it('ControllerWorkspace.worktrees 惰性解析，失败降级为空列表', async () => {
    vi.mocked(worktreeService.list).mockResolvedValue([{ path: '/wt/1' }] as never);
    const ok = await homeResolvers.ControllerWorkspace.worktrees(
      { id: 'ws-1', controllerId: 'ctrl-1' },
      {},
      ctx,
    );
    expect(ok).toHaveLength(1);
    expect(worktreeService.list).toHaveBeenCalledWith('ctrl-1', 'ws-1', 'user-1');

    vi.mocked(worktreeService.list).mockRejectedValue(new Error('relay timeout'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const degraded = await homeResolvers.ControllerWorkspace.worktrees(
      { id: 'ws-1', controllerId: 'ctrl-1' },
      {},
      ctx,
    );
    expect(degraded).toEqual([]);
  });
});
