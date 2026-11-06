// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import MessageItem from '../MessageItem';

describe('MessageItem metadata.parts 历史渲染（T-MI）', () => {
  beforeEach(() => cleanup());

  const base = {
    id: 'm1',
    sessionId: 's1',
    direction: 'input' as const,
    type: 'text' as const,
    content: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'hello\n\nworld' },
    },
    messageId: null,
    createdAt: '2026-11-05T12:00:00Z',
  };

  it('T-MI1 metadata.parts 图片缩略渲染（点击放大）', () => {
    render(
      <MessageItem
        message={{
          ...base,
          metadata: JSON.stringify({
            parts: [
              { type: 'text', text: 'hello' },
              { type: 'image', data: 'AAAA', mimeType: 'image/png', name: 'shot.png' },
            ],
          }),
        }}
      />,
    );
    expect(screen.getByTestId('message-parts')).toBeTruthy();
    expect(screen.getByTestId('message-part-image')).toBeTruthy();
    fireEvent.click(screen.getByTestId('message-part-image'));
    expect(screen.getByTestId('message-image-zoom')).toBeTruthy();
  });

  it('T-MI2 无 parts 旧消息零回归（不渲染片段区）', () => {
    render(<MessageItem message={{ ...base, metadata: null }} />);
    expect(screen.queryByTestId('message-parts')).toBeNull();
  });

  it('T-MI3 非用户消息忽略 parts', () => {
    render(
      <MessageItem
        message={{
          ...base,
          direction: 'output' as const,
          metadata: JSON.stringify({ parts: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }),
        }}
      />,
    );
    expect(screen.queryByTestId('message-parts')).toBeNull();
    cleanup();
  });
});
