import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MessageList from './MessageList';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe('MessageList', () => {
  const messages = [
    {
      id: '1',
      sessionId: 'sess-1',
      direction: 'input',
      type: 'text',
      content: 'Hello',
      metadata: null,
      createdAt: '2026-05-19T10:00:00.000Z',
    },
    {
      id: '2',
      sessionId: 'sess-1',
      direction: 'output',
      type: 'text',
      content: 'Hi there',
      metadata: null,
      createdAt: '2026-05-19T10:00:01.000Z',
    },
  ];

  it('should render empty state when no messages', () => {
    render(<MessageList messages={[]} />);
    expect(screen.getByText(/No messages yet/)).toBeDefined();
  });

  it('should render messages', () => {
    render(<MessageList messages={messages} />);
    expect(screen.getByText('Hello')).toBeDefined();
    expect(screen.getByText('Hi there')).toBeDefined();
  });

  it('should show Load earlier messages button when hasMore is true', () => {
    render(<MessageList messages={messages} hasMore={true} onLoadMore={vi.fn()} />);
    expect(screen.getByText('Load earlier messages')).toBeDefined();
  });

  it('should not show Load earlier messages when hasMore is false', () => {
    render(<MessageList messages={messages} hasMore={false} onLoadMore={vi.fn()} />);
    expect(screen.queryByText('Load earlier messages')).toBeNull();
  });

  it('should call onLoadMore when button clicked', () => {
    const onLoadMore = vi.fn();
    render(<MessageList messages={messages} hasMore={true} onLoadMore={onLoadMore} />);
    fireEvent.click(screen.getByText('Load earlier messages'));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it('should show loading spinner when loadingMore', () => {
    render(<MessageList messages={messages} hasMore={true} onLoadMore={vi.fn()} loadingMore={true} />);
    expect(screen.getByText(/Loading earlier messages/)).toBeDefined();
    expect(screen.queryByText('Load earlier messages')).toBeNull();
  });
});
