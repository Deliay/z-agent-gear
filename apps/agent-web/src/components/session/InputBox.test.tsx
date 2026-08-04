import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import InputBox from './InputBox';

describe('InputBox', () => {
  it('should render textarea and Send button', () => {
    render(<InputBox onSend={vi.fn()} disabled={false} />);
    expect(screen.getByPlaceholderText(/Type your message/)).toBeDefined();
    expect(screen.getByText('Send')).toBeDefined();
  });

  it('should call onSend with input text on submit', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText(/Type your message/);
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByText('Send'));
    expect(onSend).toHaveBeenCalledWith('Hello');
  });

  it('should clear input after sending', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText(/Type your message/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByText('Send'));
    expect(textarea.value).toBe('');
  });

  it('should not submit on Enter key (newline behavior)', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText(/Type your message/);
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('should not submit on Shift+Enter', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText(/Type your message/);
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('should submit on Ctrl+Enter', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText(/Type your message/);
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledWith('Hello');
  });

  it('should submit on Cmd+Enter', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText(/Type your message/);
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(onSend).toHaveBeenCalledWith('Hello');
  });

  it('should not submit on Ctrl+Enter with empty input', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText(/Type your message/);
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('should not submit on Ctrl+Enter with whitespace-only input', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText(/Type your message/);
    fireEvent.change(textarea, { target: { value: '   ' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('should select command with Enter when suggest panel is open', async () => {
    const onSend = vi.fn();
    const { container } = render(
      <InputBox
        onSend={onSend}
        disabled={false}
        availableCommands={[{ name: 'clear', description: 'Clear session' }]}
      />,
    );
    const textarea = screen.getByPlaceholderText(/Type your message/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '/cl' } });
    expect(container.textContent).toContain('/clear');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('/clear ');
  });

  it('should disable textarea and button when disabled', () => {
    render(<InputBox onSend={vi.fn()} disabled={true} />);
    const textarea = screen.getByPlaceholderText('Session is not active...');
    expect((textarea as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('should show Stop button when sending', () => {
    render(<InputBox onSend={vi.fn()} onStop={vi.fn()} disabled={false} sending={true} />);
    expect(screen.getByText('Stop')).toBeDefined();
    expect(screen.getByPlaceholderText('Agent is processing...')).toBeDefined();
  });

  it('should disable input when sending', () => {
    render(<InputBox onSend={vi.fn()} disabled={false} sending={true} />);
    const textarea = screen.getByPlaceholderText('Agent is processing...');
    expect((textarea as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('should not call onSend when disabled', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={true} />);
    fireEvent.click(screen.getByText('Send'));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('should not call onSend when sending', async () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    render(<InputBox onSend={onSend} onStop={onStop} disabled={false} sending={true} />);
    fireEvent.click(screen.getByText('Stop'));
    expect(onSend).not.toHaveBeenCalled();
    expect(onStop).toHaveBeenCalled();
  });

  it('should not call onSend with empty input', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    fireEvent.click(screen.getByText('Send'));
    expect(onSend).not.toHaveBeenCalled();
  });
});
