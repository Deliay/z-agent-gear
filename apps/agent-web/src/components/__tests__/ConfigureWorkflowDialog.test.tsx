import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import ConfigureWorkflowDialog from '../workflow/ConfigureWorkflowDialog';
import {
  GET_WORKFLOW_TEMPLATES,
  type GetWorkflowTemplatesQuery,
} from '@/graphql/workflow';
import {
  GET_CONTROLLERS,
  GET_ACP_CAPABILITIES,
  GET_ACP_SERVER_OPTIONS,
} from '@/graphql/queries';

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const TEMPLATES: GetWorkflowTemplatesQuery = {
  workflowTemplates: [
    {
      id: 'tpl-1',
      name: '开发工作流',
      version: 1,
      isBuiltin: false,
      description: null,
      createdAt: '2026-08-08T00:00:00Z',
      updatedAt: '2026-08-08T00:00:00Z',
      nodes: [
        {
          nodeKey: 'input',
          type: 'HUMAN',
          name: '需求输入',
          stage: '需求',
          description: null,
          prompts: null,
          artifactTitles: null,
          dependsOn: [],
          requiresWorktree: false,
        },
        {
          nodeKey: 'exec',
          type: 'AI',
          name: 'AI执行',
          stage: '开发',
          description: null,
          prompts: ['执行'],
          artifactTitles: ['产物'],
          dependsOn: ['input'],
          requiresWorktree: false,
        },
      ],
    },
  ],
} as unknown as GetWorkflowTemplatesQuery;

function setupQueries(optionsData: unknown, optionsLoading = false) {
  mockUseQuery.mockImplementation((doc: unknown) => {
    if (doc === GET_WORKFLOW_TEMPLATES) return { data: TEMPLATES };
    if (doc === GET_CONTROLLERS) {
      return {
        data: {
          controllers: [
            { id: 'ctrl-1', name: '本机', hostname: 'localhost', status: 'online' },
          ],
        },
      };
    }
    if (doc === GET_ACP_CAPABILITIES) {
      return {
        data: {
          acpCapabilities: [
            { type: 'opencode', available: true, version: '1.0.0', checkedAt: null },
          ],
        },
      };
    }
    if (doc === GET_ACP_SERVER_OPTIONS) {
      return { data: optionsData, loading: optionsLoading };
    }
    return { data: undefined, loading: false };
  });
}

async function openDialogAndSelect() {
  render(<ConfigureWorkflowDialog open onOpenChange={vi.fn()} initialTemplateId="tpl-1" />);
  // 选择 Controller
  fireEvent.click(screen.getByLabelText('Controller'));
  fireEvent.click(await screen.findByText('本机'));
  // 选择 AI 节点的 Harness 工具
  fireEvent.click(screen.getByLabelText('AI执行 Harness 工具'));
  fireEvent.click(await screen.findByText('opencode'));
}

describe('ConfigureWorkflowDialog Mode/模型动态选项', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMutation.mockReturnValue([vi.fn().mockResolvedValue({})]);
  });

  it('dismiss 后再次打开仍载入模板节点图（不复为空）', async () => {
    setupQueries({
      acpServerOptions: {
        modes: [],
        models: [],
        currentModeId: null,
        currentModelId: null,
        probedAt: '2026-08-08T00:00:00Z',
      },
    });

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>打开</button>
          <ConfigureWorkflowDialog open={open} onOpenChange={setOpen} initialTemplateId="tpl-1" />
        </>
      );
    }
    render(<Harness />);

    // 第一次打开 → 模板节点图已载入（节点 2 为 AI，AgentConfig 可见，且展开节点 2 后详情字段可见）
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    await waitFor(() => {
      expect(screen.getByLabelText('AI执行 Harness 工具')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '展开节点 2' }));
    expect(screen.getByLabelText('节点 2 标识')).toBeInTheDocument();
    expect(screen.getByLabelText('节点 2 提示词')).toHaveValue('执行');

    // dismiss（关闭对话框）
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    // 再次打开 → 节点图应重新载入，而非空
    fireEvent.click(screen.getByRole('button', { name: '打开' }));
    await waitFor(() => {
      expect(screen.getByLabelText('AI执行 Harness 工具')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: '展开节点 2' }));
    expect(screen.getByLabelText('节点 2 标识')).toBeInTheDocument();
    expect(screen.getByLabelText('节点 2 提示词')).toHaveValue('执行');
  });

  it('探测到选项时 Mode/模型渲染为下拉选择', async () => {
    setupQueries({
      acpServerOptions: {
        modes: [
          { id: 'code', name: 'Code', description: null },
          { id: 'ask', name: 'Ask', description: null },
        ],
        models: [
          { id: 'gpt-5', name: 'GPT-5', provider: null },
          { id: 'claude-4', name: 'Claude 4', provider: null },
        ],
        currentModeId: 'code',
        currentModelId: 'gpt-5',
        probedAt: '2026-08-08T00:00:00Z',
      },
    });

    await openDialogAndSelect();

    // Mode 是下拉（button），不是文本框
    const modeTrigger = screen.getByLabelText('AI执行 Mode');
    expect(modeTrigger.tagName).not.toBe('INPUT');
    fireEvent.click(modeTrigger);
    expect(await screen.findByText('Code')).toBeInTheDocument();
    expect(screen.getByText('Ask')).toBeInTheDocument();
    expect(screen.getAllByText('留空（默认）').length).toBeGreaterThan(0);

    // 选中一个 mode
    fireEvent.click(screen.getByText('Ask'));

    // 模型下拉
    const modelTrigger = screen.getByLabelText('AI执行 模型');
    expect(modelTrigger.tagName).not.toBe('INPUT');
    fireEvent.click(modelTrigger);
    expect(await screen.findByText('GPT-5')).toBeInTheDocument();
  });

  it('探测中显示提示并回退文本输入', async () => {
    setupQueries(undefined, true);
    await openDialogAndSelect();

    await waitFor(() => {
      expect(screen.getAllByText('正在拉起空实例探测可选选项…').length).toBeGreaterThan(0);
    });
    // 选项未就绪时仍是文本输入框
    expect(screen.getByLabelText('AI执行 Mode').tagName).toBe('INPUT');
    expect(screen.getByLabelText('AI执行 模型').tagName).toBe('INPUT');
  });

  it('探测无选项（工具不支持）时回退文本输入', async () => {
    setupQueries({
      acpServerOptions: {
        modes: [],
        models: [],
        currentModeId: null,
        currentModelId: null,
        probedAt: '2026-08-08T00:00:00Z',
      },
    });
    await openDialogAndSelect();

    await waitFor(() => {
      expect(screen.getByLabelText('AI执行 Mode').tagName).toBe('INPUT');
    });
    expect(screen.getByLabelText('AI执行 模型').tagName).toBe('INPUT');
  });
});

describe('ConfigureWorkflowDialog 联动上游 Pull Request', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('人类节点可切换联动并随节点图保存', async () => {
    const mutate = vi.fn().mockResolvedValue({});
    mockUseMutation.mockReturnValue([mutate]);
    setupQueries({
      acpServerOptions: { modes: [], models: [], currentModeId: null, currentModelId: null, probedAt: '2026-08-08T00:00:00Z' },
    });

    await openDialogAndSelect();
    fireEvent.click(screen.getByRole('button', { name: '展开节点 1' }));
    expect(screen.getByLabelText('节点 1 联动上游 Pull Request')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('节点 1 联动上游 Pull Request'));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    const variables = mutate.mock.calls[0][0].variables;
    expect(variables.input.nodes[0]).toMatchObject({
      nodeKey: 'input',
      linkUpstreamPullRequest: true,
    });
  });
});
