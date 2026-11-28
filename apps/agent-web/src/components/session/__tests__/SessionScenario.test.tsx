// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MessageItem from '../MessageItem';
import MessageList from '../MessageList';
import ToolCallCard from '../ToolCallCard';
import type { MergedToolCall } from '../tool-call-state';

const userMessage = {
  id: 'm-user',
  sessionId: 's1',
  direction: 'input',
  type: 'text',
  content: {
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: '请修复登录流程' },
  },
  metadata: null,
  createdAt: '2026-11-27T10:00:00.000Z',
};

const agentMessage = {
  id: 'm-agent',
  sessionId: 's1',
  direction: 'output',
  type: 'text',
  content: {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '已定位到回调页。' },
  },
  metadata: null,
  createdAt: '2026-11-27T10:00:01.000Z',
};

const toolCall: MergedToolCall = {
  toolCallId: 'tc-1',
  kind: 'edit',
  status: 'completed',
  title: '修改 SessionHeader.tsx',
  rawInput: undefined,
  rawOutput: undefined,
  content: undefined,
  locations: [{ path: 'apps/agent-web/src/components/session/SessionHeader.tsx' }],
};

describe('场景 C 会话时间线（T-SESS-TL）', () => {
  it('T-SESS-TL1: 用户消息为浅色圆角气泡（bg-muted/60，非品牌实色）', () => {
    render(<MessageItem message={userMessage} />);
    const bubble = screen.getByTestId('message-bubble');
    expect(bubble.getAttribute('data-direction')).toBe('user');
    expect(bubble.className).toContain('bg-muted/60');
    expect(bubble.className).toContain('rounded-lg');
    expect(bubble.className).not.toContain('bg-primary');
  });

  it('T-SESS-TL2: AI 消息无边框流式排布（不使用 bg-primary / border）', () => {
    render(<MessageItem message={agentMessage} />);
    const bubble = screen.getByTestId('message-bubble');
    expect(bubble.getAttribute('data-direction')).toBe('agent');
    expect(bubble.className).not.toContain('border');
    expect(bubble.className).not.toContain('bg-muted');
    expect(bubble.className).not.toContain('bg-primary');
  });

  it('T-SESS-TL3: 消息时间线使用 max-w-3xl 居中阅读宽', () => {
    render(<MessageList messages={[userMessage, agentMessage]} />);
    const column = screen.getByTestId('message-reading-column');
    expect(column.className).toContain('max-w-3xl');
    expect(column.className).toContain('mx-auto');
  });
});

describe('场景 C 工具调用卡（T-SESS-TC）', () => {
  it('T-SESS-TC1: 合并后的工具调用卡保持标题与状态摘要（不退化为 other）', () => {
    render(<ToolCallCard toolCall={toolCall} />);
    expect(screen.getByText(/修改 SessionHeader\.tsx/)).toBeInTheDocument();
    expect(screen.queryByText('工具调用：other')).toBeNull();
  });

  it('T-SESS-TC2: 工具调用卡在会话时间线中以合并结果渲染', () => {
    render(
      <MessageList
        messages={[
          {
            ...userMessage,
            id: 'tc-msg',
            content: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-1',
              kind: 'edit',
              title: '修改 SessionHeader.tsx',
              status: 'completed',
              content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
            },
          },
        ]}
      />,
    );
    expect(screen.getByText(/修改 SessionHeader\.tsx/)).toBeInTheDocument();
  });
});
