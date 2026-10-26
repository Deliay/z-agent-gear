import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  useQuery: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@apollo/client/react', () => ({
  useQuery: (query: unknown) => h.useQuery(query),
  useMutation: (mutation: { definitions?: Array<{ name?: { value?: string } }> }) => {
    const name = mutation?.definitions?.[0]?.name?.value ?? '';
    return [name.toLowerCase().includes('update') ? h.update : h.create];
  },
}));

import IssuesLinkageDialog from '../IssuesLinkageDialog';

const humanWorkflow = {
  id: 'wf-1',
  name: '开发流程',
  nodes: [{ type: 'HUMAN' }],
};
const aiOnlyWorkflow = {
  id: 'wf-2',
  name: '纯 AI 流程',
  nodes: [{ type: 'AI' }],
};

function setup(workflows: unknown[], overrides: Record<string, unknown> = {}) {
  let call = 0;
  h.useQuery.mockImplementation(() => {
    const even = call++ % 2 === 0;
    if (even) return { data: { configuredWorkflows: workflows } };
    return {
      data: {
        githubAccounts: [
          {
            installations: [
              { repos: [{ fullName: 'a/b' }, { fullName: 'a/b' }, { fullName: 'c/d' }] },
            ],
          },
        ],
      },
    };
  });
  h.create.mockResolvedValue({ data: {} });
  h.update.mockResolvedValue({ data: {} });

  const onSaved = vi.fn();
  const onClose = vi.fn();
  const onConfigureWorkflow = vi.fn();
  const utils = render(
    <IssuesLinkageDialog
      open
      controllerId="ctrl-1"
      onClose={onClose}
      onSaved={onSaved}
      onConfigureWorkflow={onConfigureWorkflow}
      {...overrides}
    />,
  );
  return { ...utils, onSaved, onClose, onConfigureWorkflow };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('IssuesLinkageDialog', () => {
  it('仅展示含 HUMAN 的工作流，默认标签 start-{工作流名字}，仓库去重并展示同步提示', () => {
    setup([humanWorkflow, aiOnlyWorkflow]);

    const select = screen.getByLabelText('工作流') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['开发流程']);
    expect(screen.getByLabelText('标签名')).toHaveValue('start-开发流程');
    expect(screen.getAllByLabelText('a/b')).toHaveLength(1);
    expect(screen.getByTestId('issue-linkage-sync-hint')).toHaveTextContent('start-开发流程');
  });

  it('无可用工作流时展示「配置工作流」并禁用保存', () => {
    const { onConfigureWorkflow } = setup([aiOnlyWorkflow]);

    expect(screen.getByText('暂无包含人类节点的工作流。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存配置' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '配置工作流' }));
    expect(onConfigureWorkflow).toHaveBeenCalled();
  });

  it('手动编辑标签后切换工作流不覆盖（dirty 标记）', () => {
    const second = { id: 'wf-3', name: '第二个流程', nodes: [{ type: 'HUMAN' }] };
    setup([humanWorkflow, second]);

    const label = screen.getByLabelText('标签名');
    fireEvent.change(label, { target: { value: 'my-label' } });
    fireEvent.change(screen.getByLabelText('工作流'), { target: { value: 'wf-3' } });

    expect(label).toHaveValue('my-label');
  });

  it('提交创建配置（仓库勾选）', async () => {
    const { onSaved } = setup([humanWorkflow]);

    fireEvent.click(screen.getByLabelText('a/b'));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    await waitFor(() => {
      expect(h.create).toHaveBeenCalledWith({
        variables: {
          input: {
            controllerId: 'ctrl-1',
            configuredWorkflowId: 'wf-1',
            labelName: 'start-开发流程',
            repoFullNames: ['a/b'],
          },
        },
      });
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('label sync failed 时展示失败仓库并保留弹窗可重试', async () => {
    setup([humanWorkflow]);
    h.create.mockRejectedValueOnce(new Error('label sync failed: c/d'));

    fireEvent.click(screen.getByLabelText('c/d'));
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('label sync failed: c/d');
    expect(screen.getByText(/配置已保存，失败仓库：c\/d/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试保存' })).toBeInTheDocument();
  });

  it('编辑态预填并提示旧标签保留，提交走 update', async () => {
    const { onSaved } = setup([humanWorkflow], {
      linkage: {
        id: 'link-1',
        controllerId: 'ctrl-1',
        configuredWorkflowId: 'wf-1',
        configuredWorkflowName: '开发流程',
        labelName: 'old-label',
        repoFullNames: ['a/b'],
        createdAt: '',
        updatedAt: '',
      },
    });

    expect(screen.getByLabelText('标签名')).toHaveValue('old-label');
    expect(screen.getByText('旧标签将保留在仓库中但不再触发。')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => {
      expect(h.update).toHaveBeenCalledWith({
        variables: {
          id: 'link-1',
          input: expect.objectContaining({ labelName: 'old-label', repoFullNames: ['a/b'] }),
        },
      });
    });
    expect(onSaved).toHaveBeenCalled();
  });
});
