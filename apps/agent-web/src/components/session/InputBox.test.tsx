import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import InputBox from './InputBox';

describe('InputBox', () => {
  it('should render textarea and Send button', () => {
    render(<InputBox onSend={vi.fn()} disabled={false} />);
    expect(screen.getByPlaceholderText('Type your message...')).toBeDefined();
    expect(screen.getByText('Send')).toBeDefined();
  });

  it('should call onSend with input text on submit', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText('Type your message...');
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByText('Send'));
    expect(onSend).toHaveBeenCalledWith('Hello');
  });

  it('should clear input after sending', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText('Type your message...') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByText('Send'));
    expect(textarea.value).toBe('');
  });

  it('should submit on Enter key', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText('Type your message...');
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('Hello');
  });

  it('should not submit on Shift+Enter', async () => {
    const onSend = vi.fn();
    render(<InputBox onSend={onSend} disabled={false} />);
    const textarea = screen.getByPlaceholderText('Type your message...');
    fireEvent.change(textarea, { target: { value: 'Hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
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
