import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import WorkflowSection from '../settings/WorkflowSection';
import {
  GET_WORKFLOW_TEMPLATES,
  GET_CONFIGURED_WORKFLOWS,
  DELETE_WORKFLOW_TEMPLATE,
} from '@/graphql/workflow';
import { GET_CONTROLLERS } from '@/graphql/queries';

const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function humanNode(nodeKey: string, name: string, stage = '方案阶段') {
  return {
    nodeKey,
    type: 'HUMAN',
    name,
    description: null,
    stage,
    prompts: null,
    artifactTitles: null,
    dependsOn: [],
    requiresWorktree: false,
  };
}

function baseTemplates() {
  return [
    {
      id: 'tpl-builtin',
      name: '开发工作流',
      description: '内置默认模板',
      version: 3,
      isBuiltin: true,
      nodes: [humanNode('requirement', '产品需求')],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'tpl-custom',
      name: '自定义模板',
      description: null,
      version: 1,
      isBuiltin: false,
      nodes: [humanNode('start', '开始')],
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    },
  ];
}

function baseConfigured() {
  return [
    {
      id: 'cfg-1',
      name: '本机开发流',
      controllerId: 'ctrl-1',
      sourceTemplateId: 'tpl-custom',
      sourceTemplateVersion: 1,
      nodes: [],
      createdAt: '2026-01-03T00:00:00Z',
      updatedAt: '2026-01-03T00:00:00Z',
    },
    {
      id: 'cfg-2',
      name: '旧版开发流',
      controllerId: 'ctrl-1',
      sourceTemplateId: 'tpl-builtin',
      sourceTemplateVersion: 1,
      nodes: [],
      createdAt: '2026-01-04T00:00:00Z',
      updatedAt: '2026-01-04T00:00:00Z',
    },
  ];
}

function baseControllers() {
  return [
    {
      id: 'ctrl-1',
      name: '我的电脑',
      hostname: 'host-1',
      type: 'local',
      status: 'online',
      keyId: 'key-1',
      version: '1.0.0',
      lastHeartbeatAt: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ];
}

function setupMocks({
  templates = baseTemplates(),
  configured = baseConfigured(),
  loading = false,
}: {
  templates?: unknown[];
  configured?: unknown[];
  loading?: boolean;
} = {}) {
  mockUseQuery.mockImplementation((doc: unknown) => {
    if (doc === GET_WORKFLOW_TEMPLATES) {
      return { data: { workflowTemplates: templates }, loading, error: null };
    }
    if (doc === GET_CONFIGURED_WORKFLOWS) {
      return { data: { configuredWorkflows: configured }, loading: false, error: null };
    }
    if (doc === GET_CONTROLLERS) {
      return { data: { controllers: baseControllers() }, loading: false, error: null };
    }
    return { data: null, loading: false, error: null };
  });
  mockUseMutation.mockReturnValue([vi.fn().mockResolvedValue({})]);
}

describe('WorkflowSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('加载中展示 loading 状态', () => {
    setupMocks({ loading: true });

    render(<WorkflowSection />);

    expect(screen.getByText('加载中...')).toBeInTheDocument();
  });

  it('展示「创建工作流模板」「配置工作流」两个按钮', () => {
    setupMocks();

    render(<WorkflowSection />);

    const createButton = screen.getByRole('button', { name: /创建工作流模板/ });
    expect(createButton).toBeInTheDocument();
    // 顶部操作区同时存在「配置工作流」按钮（模板卡片上也有同名按钮）
    const header = createButton.parentElement!;
    expect(within(header).getByRole('button', { name: '配置工作流' })).toBeInTheDocument();
  });

  it('模板列表展示内置只读标识与版本号', () => {
    setupMocks();

    render(<WorkflowSection />);

    expect(screen.getByText('开发工作流')).toBeInTheDocument();
    expect(screen.getByText('内置')).toBeInTheDocument();
    expect(screen.getByText('v3')).toBeInTheDocument();
    expect(screen.getByText('自定义模板')).toBeInTheDocument();
  });

  it('内置模板不展示编辑/删除入口，自定义模板展示', () => {
    setupMocks();

    render(<WorkflowSection />);

    const builtinCard = screen.getByText('开发工作流').closest('[data-slot="card"]')!;
    expect(within(builtinCard as HTMLElement).queryByText('编辑')).toBeNull();
    expect(within(builtinCard as HTMLElement).queryByText('删除')).toBeNull();

    const customCard = screen.getByText('自定义模板').closest('[data-slot="card"]')!;
    expect(within(customCard as HTMLElement).getByText('编辑')).toBeInTheDocument();
    expect(within(customCard as HTMLElement).getByText('删除')).toBeInTheDocument();
  });

  it('模板版本更新后已配置工作流展示非阻断提示', () => {
    setupMocks();

    render(<WorkflowSection />);

    // cfg-2 基于内置模板 v1，模板已更新至 v3
    expect(screen.getByText(/模板已更新至 v3，当前配置基于 v1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重新复制/ })).toBeInTheDocument();
    // cfg-1 基于自定义模板 v1，版本一致，无提示
    const cfg1Card = screen.getByText('本机开发流').closest('[data-slot="card"]')!;
    expect(
      within(cfg1Card as HTMLElement).queryByText(/模板已更新至/),
    ).toBeNull();
  });

  it('点击「创建工作流模板」打开模板编辑器', () => {
    setupMocks();

    render(<WorkflowSection />);

    fireEvent.click(screen.getByRole('button', { name: /创建工作流模板/ }));

    expect(screen.getByText('定义工作流的节点、依赖关系、提示词与产物。工作流的第一个节点必须是人类节点。')).toBeInTheDocument();
  });

  it('删除自定义模板时调用 deleteWorkflowTemplate', () => {
    const deleteMutate = vi.fn().mockResolvedValue({});
    setupMocks();
    mockUseMutation.mockImplementation((doc: unknown) => {
      if (doc === DELETE_WORKFLOW_TEMPLATE) return [deleteMutate];
      return [vi.fn()];
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<WorkflowSection />);

    const customCard = screen.getByText('自定义模板').closest('[data-slot="card"]')!;
    fireEvent.click(within(customCard as HTMLElement).getByText('删除'));

    expect(deleteMutate).toHaveBeenCalledWith(
      expect.objectContaining({ variables: { id: 'tpl-custom' } }),
    );
  });

  it('无模板与配置时展示空状态文案', () => {
    setupMocks({ templates: [], configured: [] });

    render(<WorkflowSection />);

    expect(screen.getByText('暂无工作流模板，点击「创建工作流模板」开始定义')).toBeInTheDocument();
    expect(screen.getByText('暂无已配置工作流，点击「配置工作流」从模板复制一份并开始配置')).toBeInTheDocument();
  });
});
