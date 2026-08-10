import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../models/workflow-template.js', () => ({
  WorkflowTemplate: {
    find: vi.fn(),
    findOne: vi.fn(),
    create: vi.fn(),
  },
}));

import {
  validateTemplateGraph,
  workflowTemplateService,
  type WorkflowTemplateNodeInput,
} from './template.js';
import { WorkflowTemplate } from '../../models/workflow-template.js';

function makeNode(overrides: Partial<WorkflowTemplateNodeInput> = {}): WorkflowTemplateNodeInput {
  return {
    nodeKey: 'A',
    type: 'HUMAN',
    name: '节点A',
    stage: '需求',
    dependsOn: [],
    requiresWorktree: false,
    ...overrides,
  };
}

function aiNode(overrides: Partial<WorkflowTemplateNodeInput> = {}): WorkflowTemplateNodeInput {
  return makeNode({ type: 'AI', prompts: ['做点什么'], ...overrides });
}

function oid(id: string) {
  return { toString: () => id } as import('mongoose').Types.ObjectId;
}

describe('validateTemplateGraph', () => {
  it('T1: 合法线性链 A→B→C 通过，拓扑序正确', () => {
    const nodes = [
      makeNode({ nodeKey: 'A' }),
      aiNode({ nodeKey: 'B', name: '节点B', dependsOn: ['A'] }),
      aiNode({ nodeKey: 'C', name: '节点C', dependsOn: ['B'] }),
    ];
    expect(validateTemplateGraph(nodes)).toEqual(['A', 'B', 'C']);
  });

  it('T2: nodeKey 重复时拒绝并报出重复 key', () => {
    const nodes = [
      makeNode({ nodeKey: 'A' }),
      aiNode({ nodeKey: 'A', name: '重复节点', dependsOn: ['A'] }),
    ];
    expect(() => validateTemplateGraph(nodes)).toThrow(/nodeKey.*重复.*A/);
  });

  it('T3: dependsOn 引用不存在的 nodeKey 时拒绝并报出缺失引用', () => {
    const nodes = [
      makeNode({ nodeKey: 'A' }),
      aiNode({ nodeKey: 'B', name: '节点B', dependsOn: ['A', 'X'] }),
    ];
    expect(() => validateTemplateGraph(nodes)).toThrow(/X/);
    expect(() => validateTemplateGraph(nodes)).toThrow(/不存在/);
  });

  it('T4: 存在环 A→B→A 时拒绝并报出环上节点', () => {
    const nodes = [
      aiNode({ nodeKey: 'A', name: '节点A', dependsOn: ['B'] }),
      aiNode({ nodeKey: 'B', name: '节点B', dependsOn: ['A'] }),
    ];
    expect(() => validateTemplateGraph(nodes)).toThrow(/环|循环/);
    expect(() => validateTemplateGraph(nodes)).toThrow(/A/);
    expect(() => validateTemplateGraph(nodes)).toThrow(/B/);
  });

  it('T5: 两个入度为 0 的节点时拒绝（首节点必须唯一）', () => {
    const nodes = [
      makeNode({ nodeKey: 'A' }),
      aiNode({ nodeKey: 'B', name: '节点B' }),
    ];
    expect(() => validateTemplateGraph(nodes)).toThrow(/首节点/);
  });

  it('T6: 首节点为 AI 节点时拒绝（首节点必须 HUMAN）', () => {
    const nodes = [
      aiNode({ nodeKey: 'A', name: '节点A' }),
      makeNode({ nodeKey: 'B', name: '节点B', dependsOn: ['A'] }),
    ];
    expect(() => validateTemplateGraph(nodes)).toThrow(/首节点/);
    expect(() => validateTemplateGraph(nodes)).toThrow(/HUMAN|人类/);
  });

  it('T7: AI 节点 prompts 为空时拒绝', () => {
    const nodes = [
      makeNode({ nodeKey: 'A' }),
      aiNode({ nodeKey: 'B', name: '节点B', dependsOn: ['A'], prompts: [] }),
    ];
    expect(() => validateTemplateGraph(nodes)).toThrow(/提示词|prompts/);
  });

  it('T8: HUMAN 节点携带 prompts 时拒绝', () => {
    const nodes = [
      makeNode({ nodeKey: 'A', prompts: ['不允许'] }),
      aiNode({ nodeKey: 'B', name: '节点B', dependsOn: ['A'] }),
    ];
    expect(() => validateTemplateGraph(nodes)).toThrow(/不允许/);
  });

  it('T8b: FLAG 节点携带 artifactTitles 时拒绝', () => {
    const nodes = [
      makeNode({ nodeKey: 'A' }),
      makeNode({ nodeKey: 'B', name: '节点B', type: 'FLAG', dependsOn: ['A'], artifactTitles: ['产物'] }),
    ];
    expect(() => validateTemplateGraph(nodes)).toThrow(/不允许/);
  });

  it('T9: 钻石型依赖 A→(B,C)→D 通过，拓扑序正确', () => {
    const nodes = [
      makeNode({ nodeKey: 'A' }),
      aiNode({ nodeKey: 'B', name: '节点B', dependsOn: ['A'] }),
      aiNode({ nodeKey: 'C', name: '节点C', dependsOn: ['A'] }),
      aiNode({ nodeKey: 'D', name: '节点D', dependsOn: ['B', 'C'] }),
    ];
    const order = validateTemplateGraph(nodes);
    expect(order).toHaveLength(4);
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('C'));
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('D'));
    expect(order.indexOf('C')).toBeLessThan(order.indexOf('D'));
  });

  it('空节点数组拒绝', () => {
    expect(() => validateTemplateGraph([])).toThrow(/至少/);
  });
});

describe('WorkflowTemplateService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('create: 校验图并以 version=1 创建', async () => {
    const created = { _id: oid('tpl-1') };
    vi.mocked(WorkflowTemplate.create).mockResolvedValue(created as never);

    const result = await workflowTemplateService.create('user-1', {
      name: '我的模板',
      nodes: [makeNode({ nodeKey: 'A' }), aiNode({ nodeKey: 'B', name: '节点B', dependsOn: ['A'] })],
    });

    expect(WorkflowTemplate.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', name: '我的模板', version: 1, isBuiltin: false }),
    );
    expect(result).toBe(created);
  });

  it('create: 非法图拒绝且不落库', async () => {
    await expect(
      workflowTemplateService.create('user-1', { name: '坏模板', nodes: [makeNode({ nodeKey: 'A' }), makeNode({ nodeKey: 'B' })] }),
    ).rejects.toThrow(/首节点/);
    expect(WorkflowTemplate.create).not.toHaveBeenCalled();
  });

  it('update: 内置模板拒绝修改', async () => {
    vi.mocked(WorkflowTemplate.findOne).mockResolvedValue({ isBuiltin: true } as never);
    await expect(
      workflowTemplateService.update('tpl-1', 'user-1', { name: 'x', nodes: [] }),
    ).rejects.toThrow(/内置模板/);
  });

  it('update: 校验图且 version 自增', async () => {
    const doc = {
      isBuiltin: false,
      version: 3,
      save: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(WorkflowTemplate.findOne).mockResolvedValue(doc as never);

    await workflowTemplateService.update('tpl-1', 'user-1', {
      name: '新名字',
      nodes: [makeNode({ nodeKey: 'A' }), aiNode({ nodeKey: 'B', name: '节点B', dependsOn: ['A'] })],
    });

    expect(doc).toMatchObject({ name: '新名字', version: 4 });
    expect(doc.save).toHaveBeenCalled();
  });

  it('update: 模板不存在时拒绝', async () => {
    vi.mocked(WorkflowTemplate.findOne).mockResolvedValue(null as never);
    await expect(
      workflowTemplateService.update('tpl-x', 'user-1', { name: 'x', nodes: [] }),
    ).rejects.toThrow(/不存在/);
  });

  it('delete: 内置模板拒绝删除', async () => {
    vi.mocked(WorkflowTemplate.findOne).mockResolvedValue({ isBuiltin: true } as never);
    await expect(workflowTemplateService.delete('tpl-1', 'user-1')).rejects.toThrow(/内置模板/);
  });

  it('delete: 普通模板删除成功', async () => {
    const doc = { isBuiltin: false, deleteOne: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(WorkflowTemplate.findOne).mockResolvedValue(doc as never);

    await expect(workflowTemplateService.delete('tpl-1', 'user-1')).resolves.toBe(true);
    expect(doc.deleteOne).toHaveBeenCalled();
  });
});
