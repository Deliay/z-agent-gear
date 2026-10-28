import { describe, it, expect, vi, beforeEach } from 'vitest';
import { threadToMarkdown, downloadThreadMarkdown } from '../export-thread';

function chunk(text: string, sessionUpdate = 'agent_message_chunk', createdAt?: string) {
  return {
    direction: 'output',
    content: { sessionUpdate, content: { type: 'text', text } } as Record<string, unknown>,
    createdAt,
  };
}

describe('threadToMarkdown', () => {
  it('should render user and assistant sections', () => {
    const markdown = threadToMarkdown([
      { direction: 'input', content: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Hello' } } as unknown as Record<string, unknown> },
      chunk('Hi there'),
    ]);

    expect(markdown).toContain('## User');
    expect(markdown).toContain('Hello');
    expect(markdown).toContain('## Assistant');
    expect(markdown).toContain('Hi there');
  });

  it('should render thinking as a thinking block', () => {
    const markdown = threadToMarkdown([
      { direction: 'output', content: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'weighing options' } } as unknown as Record<string, unknown> },
    ]);

    expect(markdown).toContain('<thinking>');
    expect(markdown).toContain('weighing options');
    expect(markdown).toContain('</thinking>');
  });

  it('should merge tool call messages by toolCallId', () => {
    const markdown = threadToMarkdown([
      {
        direction: 'output',
        content: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          kind: 'execute',
          title: 'Run tests',
          status: 'in_progress',
          rawInput: { command: 'npm test' },
        } as unknown as Record<string, unknown>,
      },
      {
        direction: 'output',
        content: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'completed',
          rawOutput: { output: 'all green' },
        } as unknown as Record<string, unknown>,
      },
    ]);

    expect(markdown).toContain('### Tool: Run tests');
    expect(markdown).toContain('- 状态: completed');
    expect(markdown).toContain('npm test');
    expect(markdown).toContain('all green');
    expect(markdown).toContain('```json');
    // 同一 toolCallId 只输出一次
    expect(markdown.match(/### Tool:/g)).toHaveLength(1);
  });

  it('should order sections by createdAt', () => {
    const markdown = threadToMarkdown([
      chunk('second', 'agent_message_chunk', '2026-01-01T10:00:02.000Z'),
      chunk('first', 'agent_message_chunk', '2026-01-01T10:00:01.000Z'),
    ]);

    expect(markdown.indexOf('first')).toBeLessThan(markdown.indexOf('second'));
  });

  it('should export images as a placeholder', () => {
    const markdown = threadToMarkdown([
      {
        direction: 'output',
        content: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'abc', mimeType: 'image/png' } } as unknown as Record<string, unknown>,
      },
    ]);

    expect(markdown).toContain('图片内容未导出');
    expect(markdown).not.toContain('data:image');
  });

  it('should handle an empty message list', () => {
    const markdown = threadToMarkdown([]);
    expect(markdown).toContain('# 会话记录');
    expect(markdown).toContain('空会话');
  });

  it('should export tool messages without toolCallId individually', () => {
    const markdown = threadToMarkdown([
      {
        direction: 'output',
        content: { sessionUpdate: 'tool_call', title: 'Anonymous tool', status: 'completed' } as unknown as Record<string, unknown>,
      },
      {
        direction: 'output',
        content: { sessionUpdate: 'tool_call', title: 'Second tool', status: 'failed' } as unknown as Record<string, unknown>,
      },
    ]);

    expect(markdown.match(/### Tool:/g)).toHaveLength(2);
    expect(markdown).toContain('Anonymous tool');
    expect(markdown).toContain('Second tool');
  });

  it('should degrade unserializable raw values to text fences', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const markdown = threadToMarkdown([
      {
        direction: 'output',
        content: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-circular',
          title: 'Circular',
          rawInput: circular,
        } as unknown as Record<string, unknown>,
      },
    ]);

    expect(markdown).toContain('```text');
  });
});

describe('downloadThreadMarkdown', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should create a blob download link and clean up', () => {
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadThreadMarkdown('session-1.md', '# hi');

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });
});
