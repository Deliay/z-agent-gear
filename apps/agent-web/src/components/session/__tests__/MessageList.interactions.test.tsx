import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import MessageList from '../MessageList';
import type { AcpMessage } from '../group-messages';
import type { SessionInteractionData } from '../../../graphql/types';

/**
 * 时间线合并（T-TL1~T-TL3）：交互项按 createdAt 与消息组稳定归并，
 * 同刻「消息组在前、交互在后」固定 tie-break；无交互时零变化。
 */

vi.mock('@apollo/client/react', () => ({
  useMutation: vi.fn(() => [vi.fn().mockResolvedValue({})]),
}));

function message(id: string, createdAt: string, text: string): AcpMessage {
  return {
    id,
    sessionId: 'sess-1',
    messageId: id,
    direction: 'inbound',
    type: 'agent',
    content: JSON.stringify({ sessionUpdate: 'agent_message_chunk', messageId: id, content: { type: 'text', text } }),
    metadata: null,
    createdAt,
  };
}

function interaction(interactionId: string, createdAt: string): SessionInteractionData {
  return {
    id: `i-${interactionId}`,
    sessionId: 'sess-1',
    interactionId,
    kind: 'ELICITATION',
    status: 'PENDING',
    mode: 'form',
    message: `interaction-${interactionId}`,
    requestedSchema: { type: 'object', properties: {} },
    url: null,
    elicitationId: null,
    toolCallId: null,
    toolCall: null,
    options: null,
    response: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt,
    respondedAt: null,
    resolvedAt: null,
    history: [],
  };
}

function renderList(ui: ReactElement) {
  return render(ui);
}

function comesBefore(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('MessageList 时间线合并', () => {
  it('T-TL1: 交互按 createdAt 插入消息之间', () => {
    renderList(
      <MessageList
        messages={[
          message('m1', '2026-11-13T00:00:00.000Z', 'first message'),
          message('m2', '2026-11-13T00:00:02.000Z', 'second message'),
        ]}
        interactions={[interaction('mid', '2026-11-13T00:00:01.000Z')]}
      />,
    );

    const first = screen.getByText('first message');
    const card = screen.getByTestId('interaction-card-mid');
    const second = screen.getByText('second message');

    expect(comesBefore(first, card)).toBe(true);
    expect(comesBefore(card, second)).toBe(true);
  });

  it('T-TL2: 同刻消息组在前、交互在后（稳定 tie-break）', () => {
    renderList(
      <MessageList
        messages={[message('m1', '2026-11-13T00:00:01.000Z', 'same time message')]}
        interactions={[interaction('same', '2026-11-13T00:00:01.000Z')]}
      />,
    );

    expect(
      comesBefore(screen.getByText('same time message'), screen.getByTestId('interaction-card-same')),
    ).toBe(true);
  });

  it('T-TL3: 无交互时时间线零变化（不渲染卡片）', () => {
    renderList(<MessageList messages={[message('m1', '2026-11-13T00:00:00.000Z', 'only message')]} />);

    expect(screen.getByText('only message')).toBeDefined();
    expect(document.querySelector('[data-interaction-id]')).toBeNull();
  });

  it('T-TL4: 只有交互（无消息）时仍渲染卡片而非空态', () => {
    renderList(<MessageList messages={[]} interactions={[interaction('only', '2026-11-13T00:00:00.000Z')]} />);

    expect(screen.getByTestId('interaction-card-only')).toBeDefined();
    expect(screen.queryByText('No messages yet. Start a conversation!')).toBeNull();
  });
});
