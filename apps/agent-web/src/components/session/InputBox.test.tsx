import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import InputBox from './InputBox';

describe('InputBox', () => {
  it('T-SESS-IN1: 渲染一体化输入浮岛与中文「发送」主按钮', () => {
    render(<InputBox onSend={vi.fn()} disabled={false} />);
    expect(screen.getByPlaceholderText(/输入消息/)).toBeDefined();
    expect(screen.getByRole('button', { name: /发送/ })).toBeDefined();
    const island = screen.getByTestId('input-island');
    expect(island.className).toContain('rounded-xl');
    expect(island.className).toContain('max-w-3xl');
    expect(island.querySelector('[data-testid="input-island-footer"]')).not.toBeNull();
    expect(island.parentElement?.className).not.toContain('border-t');
  });

  it('T-SESS-IN2: 提交时组装文本片段', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText(/输入消息/);
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));
    expect(onSend).toHaveBeenCalledWith([expect.objectContaining({ type: 'text', text: 'Hello' })]);
  });

  it('should clear input after sending', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));
    expect(textarea.value).toBe('');
  });

  it('should not submit on Enter key (newline behavior)', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText(/输入消息/);
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('should not submit on Shift+Enter', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText(/输入消息/);
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('T-SESS-IN5: Ctrl+Enter 发送', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText(/输入消息/);
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledWith([expect.objectContaining({ type: 'text', text: 'Hello' })]);
  });

  it('should submit on Cmd+Enter', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText(/输入消息/);
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(onSend).toHaveBeenCalledWith([expect.objectContaining({ type: 'text', text: 'Hello' })]);
  });

  it('should not submit on Ctrl+Enter with empty input', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText(/输入消息/);
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('should not submit on Ctrl+Enter with whitespace-only input', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText(/输入消息/);
    fireEvent.change(textarea, { target: { value: '   ' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('T-SESS-IN6: `/` 唤起命令建议面板', async () => {
    const onSend = vi.fn();
    const { container } = render(
      <InputBox
        onSend={onSend}
        disabled={false}
        availableCommands={[{ name: 'clear', description: 'Clear session' }]}
      />,
    );
    const textarea = screen.getByPlaceholderText(/输入消息/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '/cl' } });
    expect(container.textContent).toContain('/clear');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('/clear ');
  });

  it('T-SESS-IN4: 只读态禁用输入与发送', () => {
    render(<InputBox onSend={vi.fn()} disabled={true} />);
    const textarea = screen.getByPlaceholderText('会话未激活，暂不可发送');
    expect((textarea as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /发送/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('T-SESS-IN3: 处理中展示中文「停止」按钮', () => {
    render(<InputBox onSend={vi.fn()} onStop={vi.fn()} disabled={false} sending={true} />);
    expect(screen.getByRole('button', { name: '停止' })).toBeDefined();
    expect(screen.getByPlaceholderText('Agent 正在处理…')).toBeDefined();
  });

  it('should disable input when sending', () => {
    render(<InputBox onSend={vi.fn()} disabled={false} sending={true} />);
    const textarea = screen.getByPlaceholderText('Agent 正在处理…');
    expect((textarea as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('should not call onSend when disabled', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={true} />);
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('should not call onSend when sending', async () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    render(<InputBox onSend={onSend} onStop={onStop} disabled={false} sending={true} />);
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(onSend).not.toHaveBeenCalled();
    expect(onStop).toHaveBeenCalled();
  });

  it('should not call onSend with empty input', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /发送/ }));
    expect(onSend).not.toHaveBeenCalled();
  });
});
