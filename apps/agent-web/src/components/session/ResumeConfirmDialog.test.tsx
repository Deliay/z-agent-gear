import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ResumeConfirmDialog from './ResumeConfirmDialog';

describe('ResumeConfirmDialog', () => {
  it('提示检测到 AI 断连，工作流节点会话说明将自动发送工作流提示词', () => {
    render(
      <ResumeConfirmDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} isWorkflowNode />,
    );
    expect(screen.getByText('检测到 AI 断连')).toBeDefined();
    expect(screen.getByText(/是否让 AI 继续/)).toBeDefined();
    expect(screen.getByText(/工作流 MCP 工具继续之前的工作/)).toBeDefined();
  });

  it('普通会话不显示工作流提示词说明', () => {
    render(
      <ResumeConfirmDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} isWorkflowNode={false} />,
    );
    expect(screen.getByText(/是否让 AI 继续/)).toBeDefined();
    expect(screen.queryByText(/工作流 MCP 工具/)).toBeNull();
  });

  it('确认与取消回调', () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(<ResumeConfirmDialog open onOpenChange={onOpenChange} onConfirm={onConfirm} isWorkflowNode={false} />);

    fireEvent.click(screen.getByText('让 AI 继续'));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('取消'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
