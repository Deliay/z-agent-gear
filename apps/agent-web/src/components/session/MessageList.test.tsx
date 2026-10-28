import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { Mock } from 'vitest';
import MessageList from './MessageList';
import { groupMessages } from './group-messages';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe('groupMessages', () => {
  function chunk(id: string, text: string, messageId?: string | null) {
    return {
      id,
      sessionId: 'sess-1',
      direction: 'output',
      type: 'text',
      content: JSON.stringify({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        ...(messageId ? { messageId } : {}),
      }),
      metadata: null,
      createdAt: '2026-05-19T10:00:01.000Z',
    };
  }

  it('should merge chunks with the same messageId into one group', () => {
    const groups = groupMessages([chunk('1', 'Hello', 'msg-1'), chunk('2', ' world', 'msg-1')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe('agent_message');
    expect(groups[0].messages).toHaveLength(2);
    expect(groups[0].messageId).toBe('msg-1');
  });

  it('should not merge chunks with different messageIds', () => {
    const groups = groupMessages([chunk('1', 'Hello', 'msg-1'), chunk('2', ' world', 'msg-2')]);
    expect(groups).toHaveLength(2);
    expect(groups[0].messages).toHaveLength(1);
    expect(groups[1].messages).toHaveLength(1);
  });

  it('should group non-contiguous chunks with the same messageId together', () => {
    const groups = groupMessages([
      chunk('1', 'Hello', 'msg-1'),
      chunk('2', ' tool call', 'msg-2'),
      chunk('3', ' world', 'msg-1'),
    ]);
    const msg1Groups = groups.filter((g) => g.messageId === 'msg-1');
    expect(msg1Groups).toHaveLength(1);
    expect(msg1Groups[0].messages.map((m) => m.id)).toEqual(['1', '3']);
  });

  it('should fall back to consecutive grouping when no messageId', () => {
    const groups = groupMessages([chunk('1', 'Hello'), chunk('2', ' world')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].messages).toHaveLength(2);
    expect(groups[0].messageId).toBeNull();
  });

  it('should not merge CREN2-style mermaid chunks that carry distinct messageIds (R-2)', () => {
    const chunks = [
      chunk('1', '```mermaid\ngraph TD;\n  A-->B;\n```', 'cren2-valid'),
      chunk('2', '```mermaid\nthis is definitely not a diagram\n```', 'cren2-invalid'),
      chunk('3', 'after-mermaid-marker', 'cren2-plain'),
    ];

    const groups = groupMessages(chunks);

    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.messageId)).toEqual(['cren2-valid', 'cren2-invalid', 'cren2-plain']);
    expect(groups.map((g) => g.messages)).toHaveLength(3);
  });

  it('should not throw on malformed rawInput JSON (R-5)', () => {
    const malformed = {
      id: '1',
      sessionId: 'sess-1',
      direction: 'output',
      type: 'text',
      content: JSON.stringify({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        kind: 'other',
        rawInput: '{not valid json',
      }),
      metadata: null,
      createdAt: '2026-05-19T10:00:01.000Z',
    };
    const nullLiteral = {
      ...malformed,
      id: '2',
      content: JSON.stringify({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-2',
        kind: 'other',
        rawInput: 'null',
      }),
    };

    expect(() => groupMessages([malformed, nullLiteral])).not.toThrow();
    const groups = groupMessages([malformed, nullLiteral]);
    expect(groups.map((g) => g.type)).toEqual(['tool_call', 'tool_call']);
  });
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

describe('MessageList scroll following', () => {
  const triggerIntersection = (isIntersecting: boolean) => {
    (globalThis as unknown as { __triggerIntersection: (v: boolean) => void }).__triggerIntersection(isIntersecting);
  };

  const baseMessages = [
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

  const appended = {
    id: '3',
    sessionId: 'sess-1',
    direction: 'output',
    type: 'text',
    content: 'New message',
    metadata: null,
    createdAt: '2026-05-19T10:00:02.000Z',
  };

  function messagesWithNew(count = 1) {
    return [
      ...baseMessages,
      ...Array.from({ length: count }, (_, i) => ({
        ...appended,
        id: `new-${i}`,
        content: `New message ${i}`,
      })),
    ];
  }

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    (globalThis as unknown as { __resetIntersectionObservers: () => void }).__resetIntersectionObservers();
  });

  it('should keep following and scroll when the viewport is at the bottom', () => {
    const scrollSpy = Element.prototype.scrollIntoView as Mock;
    const { rerender } = render(<MessageList messages={baseMessages} />);
    scrollSpy.mockClear();

    act(() => triggerIntersection(true));
    rerender(<MessageList messages={messagesWithNew()} />);

    expect(scrollSpy).toHaveBeenCalled();
    expect(screen.queryByTestId('scroll-to-bottom')).toBeNull();
  });

  it('should pause following and show the button + dot when scrolled up', () => {
    const scrollSpy = Element.prototype.scrollIntoView as Mock;
    const { rerender } = render(<MessageList messages={baseMessages} />);
    scrollSpy.mockClear();

    act(() => triggerIntersection(false));
    rerender(<MessageList messages={messagesWithNew()} />);

    expect(scrollSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('scroll-to-bottom')).toBeDefined();
    expect(screen.getByTestId('scroll-to-bottom-dot')).toBeDefined();
  });

  it('should restore following when the button is clicked', () => {
    const scrollSpy = Element.prototype.scrollIntoView as Mock;
    const { rerender } = render(<MessageList messages={baseMessages} />);
    scrollSpy.mockClear();

    act(() => triggerIntersection(false));
    rerender(<MessageList messages={messagesWithNew()} />);
    fireEvent.click(screen.getByRole('button', { name: '回到底部' }));

    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth' });
    expect(screen.queryByTestId('scroll-to-bottom')).toBeNull();
  });

  function setGeometry(container: HTMLElement, { scrollHeight, clientHeight, scrollTop }: {
    scrollHeight: number;
    clientHeight: number;
    scrollTop: number;
  }) {
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: clientHeight });
    container.scrollTop = scrollTop;
  }

  it('should not pull the user back down when an IO callback lags behind the scroll event (R-12)', () => {
    const scrollSpy = Element.prototype.scrollIntoView as Mock;
    const { rerender } = render(<MessageList messages={baseMessages} />);
    scrollSpy.mockClear();

    const container = screen.getByTestId('message-scroll-container');
    setGeometry(container, { scrollHeight: 2000, clientHeight: 500, scrollTop: 100 });
    fireEvent.scroll(container);

    rerender(<MessageList messages={messagesWithNew()} />);

    expect(scrollSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('scroll-to-bottom')).toBeDefined();
  });

  it('should keep following when IO reports away from bottom during content growth (R-12)', () => {
    const scrollSpy = Element.prototype.scrollIntoView as Mock;
    const { rerender } = render(<MessageList messages={baseMessages} />);
    scrollSpy.mockClear();

    const container = screen.getByTestId('message-scroll-container');
    setGeometry(container, { scrollHeight: 2000, clientHeight: 500, scrollTop: 1490 });
    fireEvent.scroll(container);

    act(() => triggerIntersection(false));
    rerender(<MessageList messages={messagesWithNew()} />);

    expect(scrollSpy).toHaveBeenCalled();
    expect(screen.queryByTestId('scroll-to-bottom')).toBeNull();
  });

  it('should not auto-load earlier history during the initial programmatic scroll (R-14)', () => {
    const onLoadMore = vi.fn();
    render(<MessageList messages={baseMessages} hasMore={true} onLoadMore={onLoadMore} />);

    const container = screen.getByTestId('message-scroll-container');
    setGeometry(container, { scrollHeight: 2000, clientHeight: 500, scrollTop: 0 });
    fireEvent.scroll(container);

    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('should restore the scroll position after prepending earlier history', async () => {
    const { rerender } = render(<MessageList messages={baseMessages} hasMore={true} onLoadMore={vi.fn()} />);
    const container = screen.getByTestId('message-scroll-container');
    setGeometry(container, { scrollHeight: 2000, clientHeight: 500, scrollTop: 100 });

    fireEvent.click(screen.getByText('Load earlier messages'));
    setGeometry(container, { scrollHeight: 3000, clientHeight: 500, scrollTop: 100 });

    const older = {
      id: '0',
      sessionId: 'sess-1',
      direction: 'input',
      type: 'text',
      content: 'Even older',
      metadata: null,
      createdAt: '2026-05-19T09:59:59.000Z',
    };
    rerender(<MessageList messages={[older, ...baseMessages]} hasMore={true} onLoadMore={vi.fn()} />);

    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    expect(container.scrollTop).toBe(1100);
  });

  it('should not swallow the next append after an SSE group replacement (M-13)', () => {
    const scrollSpy = Element.prototype.scrollIntoView as Mock;
    const { rerender } = render(<MessageList messages={baseMessages} />);

    const replaced = [
      { ...baseMessages[0], id: '10' },
      { ...baseMessages[1], id: '11' },
    ];
    rerender(<MessageList messages={replaced} />);
    scrollSpy.mockClear();

    rerender(<MessageList messages={[...replaced, { ...appended, id: '12' }]} />);

    expect(scrollSpy).toHaveBeenCalled();
  });
});
