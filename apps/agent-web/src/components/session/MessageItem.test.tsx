import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MessageItem from './MessageItem';

describe('MessageItem', () => {
  const userMessage = {
    id: '1',
    sessionId: 'sess-1',
    direction: 'input',
    type: 'text',
    content: 'Hello Agent',
    metadata: null,
    createdAt: '2026-05-19T10:00:00.000Z',
  };

  const agentMessage = {
    id: '2',
    sessionId: 'sess-1',
    direction: 'output',
    type: 'text',
    content: 'Hello User',
    metadata: null,
    createdAt: '2026-05-19T10:00:01.000Z',
  };

  it('should render user message aligned right with blue style', () => {
    render(<MessageItem message={userMessage} />);
    const msg = screen.getByText('Hello Agent');
    expect(msg).toBeDefined();
    expect(msg.closest('.flex')?.className).toContain('justify-end');
  });

  it('should break long unbroken user text instead of stretching the container', () => {
    render(<MessageItem message={{ ...userMessage, content: 'x'.repeat(500) }} />);
    const msg = screen.getByText('x'.repeat(500));
    expect(msg.className).toContain('whitespace-pre-wrap');
    expect(msg.className).toContain('break-all');
  });

  it('should render agent message aligned left with white style', () => {
    render(<MessageItem message={agentMessage} />);
    const msg = screen.getByText('Hello User');
    expect(msg).toBeDefined();
    expect(msg.closest('.flex')?.className).toContain('justify-start');
  });

  it('should show type label for tool_call messages', () => {
    const toolCall = { ...agentMessage, type: 'tool_call', content: 'search("test")' };
    render(<MessageItem message={toolCall} />);
    expect(screen.getByText('Tool Call')).toBeDefined();
  });

  it('should show type label for error messages', () => {
    const error = { ...agentMessage, type: 'error', content: 'Something failed' };
    render(<MessageItem message={error} />);
    expect(screen.getByText('Error')).toBeDefined();
  });

  it('should render markdown in agent messages', () => {
    const md = { ...agentMessage, content: '**bold text** and `inline code`' };
    render(<MessageItem message={md} />);
    expect(screen.getByText('bold text')).toBeDefined();
    expect(screen.getByText('inline code')).toBeDefined();
  });

  it('should render code blocks with syntax highlighting', () => {
    const code = {
      ...agentMessage,
      content: '```javascript\nconst x = 1;\n```',
    };
    const { container } = render(<MessageItem message={code} />);
    expect(container.querySelector('pre')).toBeDefined();
  });

  it('should render plain text for user messages without markdown', () => {
    render(<MessageItem message={userMessage} />);
    expect(screen.getByText('Hello Agent')).toBeDefined();
  });

  it('should display formatted timestamp', () => {
    render(<MessageItem message={userMessage} />);
    expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeDefined();
  });

  it('should show copy actions for agent messages only', () => {
    const agent = render(<MessageItem message={agentMessage} />);
    expect(screen.getByRole('button', { name: '复制 Markdown' })).toBeDefined();
    expect(screen.getByRole('button', { name: '复制纯文本' })).toBeDefined();
    agent.unmount();

    render(<MessageItem message={userMessage} />);
    expect(screen.queryByRole('button', { name: '复制 Markdown' })).toBeNull();
  });

  it('should copy plain text derived from markdown without code-block chrome (R-13)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<MessageItem message={{ ...agentMessage, content: '```typescript\nconst a = 1;\n```' }} />);
    fireEvent.click(screen.getByRole('button', { name: '复制纯文本' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('const a = 1;'));
    expect(writeText.mock.calls[0][0]).not.toContain('typescript');
  });

  it('should not show copy actions for non-text messages (M-12)', () => {
    render(<MessageItem message={{ ...agentMessage, type: 'tool_call', content: 'search("x")' }} />);

    expect(screen.queryByRole('button', { name: '复制 Markdown' })).toBeNull();
    expect(screen.queryByRole('button', { name: '复制纯文本' })).toBeNull();
  });
});
