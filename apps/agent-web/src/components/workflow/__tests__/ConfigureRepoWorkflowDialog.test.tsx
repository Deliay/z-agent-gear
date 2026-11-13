import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  configure: vi.fn(),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (...args: unknown[]) => h.useQuery(...args),
  useMutation: (...args: unknown[]) => h.useMutation(...args),
}));

vi.mock('../WorkflowGraphEditor', () => ({
  default: ({ nodes }: { nodes: unknown[] }) => (
    <div data-testid="stub-graph-editor">{nodes.length} nodes</div>
  ),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import ConfigureRepoWorkflowDialog from '../ConfigureRepoWorkflowDialog';

const humanOnlyTemplate = {
  fileName: 'dev.json',
  name: '开发流程',
  description: null,
  nodeCount: 1,
  valid: true,
  errors: [],
  nodes: [
    {
      nodeKey: 'requirement',
      type: 'HUMAN' as const,
      name: '产品需求',
      description: '输入需求',
      stage: '需求',
      prompts: null,
      artifactTitles: null,
      dependsOn: [],
      requiresWorktree: false,
      linkUpstreamPullRequest: false,
      sortOrder: null,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.useQuery.mockReturnValue({
    data: { acpCapabilities: [{ type: 'opencode', available: true }] },
    loading: false,
  });
  h.useMutation.mockReturnValue([h.configure]);
  h.configure.mockResolvedValue({ data: { configureRepoWorkflow: { id: 'cfg-1' } } });
});

describe('ConfigureRepoWorkflowDialog（T-RW-WEB7）', () => {
  it('以模板节点预填、名称默认模板名，提交映射 {workspaceId, fileName, name, nodes}', async () => {
    const onOpenChange = vi.fn();
    const onConfigured = vi.fn();

    render(
      <ConfigureRepoWorkflowDialog
        open
        onOpenChange={onOpenChange}
        workspaceId="ws-1"
        controllerId="ctrl-1"
        template={humanOnlyTemplate}
        onConfigured={onConfigured}
      />,
    );

    expect(screen.getByTestId('stub-graph-editor')).toHaveTextContent('1 nodes');
    expect(screen.getByLabelText('工作流名称')).toHaveValue('开发流程');

    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(h.configure).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: {
            input: expect.objectContaining({
              workspaceId: 'ws-1',
              fileName: 'dev.json',
              name: '开发流程',
              nodes: [
                expect.objectContaining({
                  nodeKey: 'requirement',
                  type: 'HUMAN',
                  name: '产品需求',
                  dependsOn: [],
                  agentConfig: null,
                }),
              ],
            }),
          },
        }),
      );
    });
    expect(onConfigured).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
