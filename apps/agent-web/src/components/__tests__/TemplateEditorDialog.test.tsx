import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TemplateEditorDialog from '../workflow/TemplateEditorDialog';
import {
  createEmptyNode,
  validateTemplateNodes,
} from '../workflow/template-validation';

const mockUseMutation = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderDialog(props: Partial<Parameters<typeof TemplateEditorDialog>[0]> = {}) {
  return render(
    <TemplateEditorDialog open onOpenChange={vi.fn()} {...props} />,
  );
}

describe('TemplateEditorDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMutation.mockReturnValue([vi.fn().mockResolvedValue({})]);
  });

  it('创建模式：默认包含一个人类节点', () => {
    renderDialog();

    expect(screen.getByText('创建工作流模板')).toBeInTheDocument();
    expect(screen.getByLabelText('节点 1 标识')).toBeInTheDocument();
    // 默认节点类型为人类
    expect(screen.getByRole('button', { name: '人类' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('模板名称为空时保存展示校验错误且不调用 mutation', () => {
    const mutate = vi.fn();
    mockUseMutation.mockReturnValue([mutate]);
    renderDialog();

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(screen.getByText('模板名称不能为空')).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('合法表单保存时调用 createWorkflowTemplate', async () => {
    const mutate = vi.fn().mockResolvedValue({});
    mockUseMutation.mockReturnValue([mutate]);
    renderDialog();

    fireEvent.change(screen.getByLabelText('模板名称'), { target: { value: '测试模板' } });
    fireEvent.change(screen.getByLabelText('节点 1 标识'), { target: { value: 'requirement' } });
    fireEvent.change(screen.getByLabelText('节点 1 名称'), { target: { value: '产品需求' } });
    fireEvent.change(screen.getByLabelText('节点 1 阶段'), { target: { value: '方案阶段' } });

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mutate).toHaveBeenCalled());

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: {
          input: expect.objectContaining({
            name: '测试模板',
            nodes: [
              expect.objectContaining({
                nodeKey: 'requirement',
                type: 'HUMAN',
                name: '产品需求',
                stage: '方案阶段',
                dependsOn: [],
              }),
            ],
          }),
        },
      }),
    );
  });

  it('AI 节点提示词为空时展示校验错误', () => {
    const mutate = vi.fn();
    mockUseMutation.mockReturnValue([mutate]);
    renderDialog();

    fireEvent.change(screen.getByLabelText('模板名称'), { target: { value: '测试模板' } });
    fireEvent.change(screen.getByLabelText('节点 1 标识'), { target: { value: 'requirement' } });
    fireEvent.change(screen.getByLabelText('节点 1 名称'), { target: { value: '产品需求' } });
    fireEvent.change(screen.getByLabelText('节点 1 阶段'), { target: { value: '方案阶段' } });

    // 添加一个 AI 节点并依赖首节点
    fireEvent.click(screen.getByRole('button', { name: /添加节点/ }));
    fireEvent.change(screen.getByLabelText('节点 2 标识'), { target: { value: 'plan' } });
    fireEvent.change(screen.getByLabelText('节点 2 名称'), { target: { value: '产出方案' } });
    fireEvent.change(screen.getByLabelText('节点 2 阶段'), { target: { value: '方案阶段' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /requirement/ }));

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(screen.getByText(/AI 节点至少需要一条提示词/)).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('流程预览按阶段分组展示节点', () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText('节点 1 标识'), { target: { value: 'requirement' } });
    fireEvent.change(screen.getByLabelText('节点 1 名称'), { target: { value: '产品需求' } });
    fireEvent.change(screen.getByLabelText('节点 1 阶段'), { target: { value: '方案阶段' } });

    const preview = screen.getByTestId('flow-preview');
    expect(preview).toHaveTextContent('流程预览（只读）');
    expect(preview).toHaveTextContent('方案阶段');
    expect(preview).toHaveTextContent('产品需求');
  });
});

describe('validateTemplateNodes', () => {
  it('合法线性链通过', () => {
    const human = { ...createEmptyNode('HUMAN'), nodeKey: 'a', name: 'A', stage: 'S' };
    const ai = {
      ...createEmptyNode('AI'),
      nodeKey: 'b',
      name: 'B',
      stage: 'S',
      promptsText: '做点事',
      dependsOn: ['a'],
    };
    expect(validateTemplateNodes([human, ai])).toEqual([]);
  });

  it('nodeKey 重复被拒绝', () => {
    const a = { ...createEmptyNode('HUMAN'), nodeKey: 'x', name: 'A', stage: 'S' };
    const b = { ...createEmptyNode('HUMAN'), nodeKey: 'x', name: 'B', stage: 'S', dependsOn: ['x'] };
    expect(validateTemplateNodes([a, b]).join('\n')).toContain('重复');
  });

  it('dependsOn 引用不存在的节点被拒绝', () => {
    const a = { ...createEmptyNode('HUMAN'), nodeKey: 'a', name: 'A', stage: 'S' };
    const b = { ...createEmptyNode('HUMAN'), nodeKey: 'b', name: 'B', stage: 'S', dependsOn: ['missing'] };
    expect(validateTemplateNodes([a, b]).join('\n')).toContain('不存在');
  });

  it('两个首节点被拒绝', () => {
    const a = { ...createEmptyNode('HUMAN'), nodeKey: 'a', name: 'A', stage: 'S' };
    const b = { ...createEmptyNode('HUMAN'), nodeKey: 'b', name: 'B', stage: 'S' };
    expect(validateTemplateNodes([a, b]).join('\n')).toContain('首节点必须唯一');
  });

  it('首节点为 AI 节点被拒绝', () => {
    const ai = {
      ...createEmptyNode('AI'),
      nodeKey: 'a',
      name: 'A',
      stage: 'S',
      promptsText: '做点事',
    };
    expect(validateTemplateNodes([ai]).join('\n')).toContain('首节点必须是人类节点');
  });

  it('AI 节点 prompts 为空被拒绝', () => {
    const human = { ...createEmptyNode('HUMAN'), nodeKey: 'a', name: 'A', stage: 'S' };
    const ai = { ...createEmptyNode('AI'), nodeKey: 'b', name: 'B', stage: 'S', dependsOn: ['a'] };
    expect(validateTemplateNodes([human, ai]).join('\n')).toContain('至少需要一条提示词');
  });
});
