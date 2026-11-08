import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RepoWorkflowPromptDialog from '../RepoWorkflowPromptDialog';
import {
  hasPromptedRepoWorkflow,
  resetRepoWorkflowPrompted,
} from '@/stores/repo-workflow-prompt';

const templates = [
  {
    fileName: 'dev.json',
    name: '开发流程',
    description: null,
    nodeCount: 2,
    valid: true,
    errors: [],
    nodes: [],
  },
  {
    fileName: 'deploy.json',
    name: '部署流程',
    description: null,
    nodeCount: 1,
    valid: true,
    errors: [],
    nodes: [],
  },
];

beforeEach(() => {
  resetRepoWorkflowPrompted();
});

describe('RepoWorkflowPromptDialog（T-RW-WEB4）', () => {
  it('列出合法模板；「去配置」预选第一个模板并记入会话记忆', () => {
    const onConfigure = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <RepoWorkflowPromptDialog
        open
        onOpenChange={onOpenChange}
        workspaceId="ws-1"
        templates={templates}
        onConfigure={onConfigure}
      />,
    );

    expect(screen.getByText('开发流程')).toBeInTheDocument();
    expect(screen.getByText('部署流程')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '去配置' }));

    expect(onConfigure).toHaveBeenCalledWith(templates[0]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(hasPromptedRepoWorkflow('ws-1')).toBe(true);
  });

  it('「取消」关闭并记入会话记忆（同工作区不再自动弹）', () => {
    const onOpenChange = vi.fn();

    render(
      <RepoWorkflowPromptDialog
        open
        onOpenChange={onOpenChange}
        workspaceId="ws-2"
        templates={templates}
        onConfigure={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(hasPromptedRepoWorkflow('ws-2')).toBe(true);
    expect(hasPromptedRepoWorkflow('ws-1')).toBe(false);
  });
});
