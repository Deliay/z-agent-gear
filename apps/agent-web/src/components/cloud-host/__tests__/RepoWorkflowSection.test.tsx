import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  GET_CONTROLLER_WORKSPACES,
} from '@/graphql/queries';
import {
  GET_CONFIGURED_WORKFLOWS,
  REPO_WORKFLOW_TEMPLATES,
} from '@/graphql/workflow';

const h = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  deleteConfigured: vi.fn(),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => h.useQuery(...args),
  useMutation: (...args: unknown[]) => h.useMutation(...args),
}));

vi.mock('../../workflow/ConfigureRepoWorkflowDialog', () => ({
  default: ({ open, template }: { open: boolean; template: { fileName: string } | null }) =>
    open ? <div data-testid="stub-configure-dialog">{template?.fileName}</div> : null,
}));

import RepoWorkflowSection from '../RepoWorkflowSection';

const workspaces = [
  {
    id: 'ws-default',
    userId: 'user-1',
    controllerId: 'ctrl-1',
    name: 'project',
    path: '/home/worker/workspace/project',
    isEnabled: true,
    createdAt: '',
    updatedAt: '',
  },
  {
    id: 'ws-other',
    userId: 'user-1',
    controllerId: 'ctrl-1',
    name: 'other',
    path: '/home/worker/other',
    isEnabled: true,
    createdAt: '',
    updatedAt: '',
  },
];

const validTemplate = {
  fileName: 'dev.json',
  name: '开发流程',
  description: null,
  nodeCount: 2,
  valid: true,
  errors: [],
  nodes: [],
};

const invalidTemplate = {
  fileName: 'broken.json',
  name: null,
  description: null,
  nodeCount: null,
  valid: false,
  errors: ['不是合法的 JSON 文件'],
  nodes: [],
};

function setupQueries(overrides: {
  templates?: unknown[];
  configured?: unknown[];
  templatesLoading?: boolean;
  refetchTemplates?: ReturnType<typeof vi.fn>;
} = {}) {
  const refetchTemplates = overrides.refetchTemplates ?? vi.fn();
  h.useQuery.mockImplementation((query: unknown) => {
    if (query === GET_CONTROLLER_WORKSPACES) {
      return { data: { controllerWorkspaces: workspaces }, loading: false, refetch: vi.fn() };
    }
    if (query === REPO_WORKFLOW_TEMPLATES) {
      return {
        data: { repoWorkflowTemplates: overrides.templates ?? [] },
        loading: overrides.templatesLoading ?? false,
        refetch: refetchTemplates,
      };
    }
    if (query === GET_CONFIGURED_WORKFLOWS) {
      return { data: { configuredWorkflows: overrides.configured ?? [] }, loading: false, refetch: vi.fn() };
    }
    return { data: null, loading: false, refetch: vi.fn() };
  });
  h.useMutation.mockReturnValue([h.deleteConfigured]);
  return { refetchTemplates };
}

const baseProps = {
  controllerId: 'ctrl-1',
  controllerVersion: '2.18.0',
  cloudHost: { status: 'RUNNING', deletedAt: null, defaultWorkspace: '/home/worker/workspace/project' },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.deleteConfigured.mockResolvedValue({ data: { deleteConfiguredWorkflow: true } });
});

describe('RepoWorkflowSection 模板列表（T-RW-WEB1）', () => {
  it('合法模板可配置；不合法项灰色并展示原因', () => {
    setupQueries({ templates: [validTemplate, invalidTemplate] });

    render(<RepoWorkflowSection {...baseProps} />);

    expect(screen.getByText('开发流程')).toBeInTheDocument();
    expect(screen.getByText('dev.json')).toBeInTheDocument();
    expect(screen.getByText('2 个节点')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '配置' })).toBeInTheDocument();

    expect(screen.getByTestId('repo-template-broken.json')).toHaveTextContent('broken.json');
    expect(screen.getByText('不是合法的 JSON 文件')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '配置' })).toHaveLength(1);
  });

  it('无模板展示空态文案', () => {
    setupQueries({ templates: [] });
    render(<RepoWorkflowSection {...baseProps} />);
    expect(screen.getByText('未检测到项目工作流模板')).toBeInTheDocument();
  });
});

describe('RepoWorkflowSection 状态与版本（T-RW-WEB2）', () => {
  it('非 RUNNING 整区块只读提示', () => {
    setupQueries();
    render(
      <RepoWorkflowSection
        {...baseProps}
        cloudHost={{ ...baseProps.cloudHost, status: 'STOPPED' }}
      />,
    );
    expect(screen.getByText('云电脑运行中才可检测与配置')).toBeInTheDocument();
  });

  it('控制器版本不足提示升级', () => {
    setupQueries();
    render(<RepoWorkflowSection {...baseProps} controllerVersion="2.17.0" />);
    expect(screen.getByText('升级云电脑工作组件后可检测项目模板')).toBeInTheDocument();
  });
});

describe('RepoWorkflowSection 操作（T-RW-WEB3 / T-RW-WEB8）', () => {
  it('「重新检测」触发 refetch；「配置」打开弹窗并以模板预填', () => {
    const { refetchTemplates } = setupQueries({ templates: [validTemplate] });

    render(<RepoWorkflowSection {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: '重新检测' }));
    expect(refetchTemplates).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    expect(screen.getByTestId('stub-configure-dialog')).toHaveTextContent('dev.json');
  });

  it('已配置列表仅展示 REPO 来源并展示来源路径；删除调用 mutation', async () => {
    setupQueries({
      templates: [],
      configured: [
        {
          id: 'repo-1',
          name: '项目开发流',
          controllerId: 'ctrl-1',
          sourceTemplateId: null,
          sourceTemplateVersion: null,
          sourceKind: 'REPO',
          sourceRepoPath: '.zag/workflow/templates/dev.json',
          sourceWorkspaceId: 'ws-default',
          nodes: [],
          createdBy: 'HUMAN',
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'platform-1',
          name: '平台流',
          controllerId: 'ctrl-1',
          sourceTemplateId: null,
          sourceTemplateVersion: null,
          sourceKind: 'PLATFORM',
          sourceRepoPath: null,
          sourceWorkspaceId: null,
          nodes: [],
          createdBy: 'HUMAN',
          createdAt: '',
          updatedAt: '',
        },
      ],
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<RepoWorkflowSection {...baseProps} />);

    expect(screen.getByText('项目开发流')).toBeInTheDocument();
    expect(screen.getByText('.zag/workflow/templates/dev.json')).toBeInTheDocument();
    expect(screen.queryByText('平台流')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => {
      expect(h.deleteConfigured).toHaveBeenCalledWith(
        expect.objectContaining({ variables: { id: 'repo-1' } }),
      );
    });
  });
});
