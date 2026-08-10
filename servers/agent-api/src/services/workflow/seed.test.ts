import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../models/workflow-template.js', () => ({
  WorkflowTemplate: {
    findOne: vi.fn(),
    create: vi.fn(),
  },
}));

import { seedBuiltinWorkflowTemplate, BUILTIN_TEMPLATE_NODES, BUILTIN_TEMPLATE_NAME } from './seed.js';
import { validateTemplateGraph } from './template.js';
import { WorkflowTemplate } from '../../models/workflow-template.js';

describe('seedBuiltinWorkflowTemplate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('内置模板定义自身通过图校验（10 节点、首节点 HUMAN、阶段划分正确）', () => {
    expect(BUILTIN_TEMPLATE_NODES).toHaveLength(10);
    expect(() => validateTemplateGraph(BUILTIN_TEMPLATE_NODES)).not.toThrow();
    expect(BUILTIN_TEMPLATE_NODES[0]).toMatchObject({ type: 'HUMAN', dependsOn: [] });
    expect(BUILTIN_TEMPLATE_NODES[BUILTIN_TEMPLATE_NODES.length - 1]).toMatchObject({ type: 'FLAG' });
    expect(BUILTIN_TEMPLATE_NODES.slice(0, 5).every((n) => n.stage === '方案阶段')).toBe(true);
    expect(BUILTIN_TEMPLATE_NODES.slice(5).every((n) => n.stage === '实现阶段')).toBe(true);
    // AI 节点均有正式提示词；代码相关节点需要 worktree
    for (const node of BUILTIN_TEMPLATE_NODES.filter((n) => n.type === 'AI')) {
      expect(node.prompts?.length).toBeGreaterThan(0);
      expect(node.requiresWorktree).toBe(true);
    }
  });

  it('不存在时创建内置模板（isBuiltin、userId 为空、version=1）', async () => {
    vi.mocked(WorkflowTemplate.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    } as never);

    await seedBuiltinWorkflowTemplate();

    expect(WorkflowTemplate.findOne).toHaveBeenCalledWith({ isBuiltin: true, name: BUILTIN_TEMPLATE_NAME });
    expect(WorkflowTemplate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        name: BUILTIN_TEMPLATE_NAME,
        version: 1,
        isBuiltin: true,
        nodes: BUILTIN_TEMPLATE_NODES,
      }),
    );
  });

  it('幂等：已存在时跳过创建（version 不重复自增）', async () => {
    vi.mocked(WorkflowTemplate.findOne).mockReturnValue({
      lean: vi.fn().mockResolvedValue({ _id: 'tpl-1', version: 1 }),
    } as never);

    await seedBuiltinWorkflowTemplate();

    expect(WorkflowTemplate.create).not.toHaveBeenCalled();
  });
});
