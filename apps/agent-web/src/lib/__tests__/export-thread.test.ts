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

  it('should merge streaming chunks of one message into a single section (R-10)', () => {
    const markdown = threadToMarkdown([
      chunk('Hello'),
      chunk(' world'),
      chunk('!'),
    ]);

    expect(markdown).toContain('Hello world!');
    expect(markdown).not.toContain('Hello\n\n');
    expect(markdown.match(/## Assistant/g)).toHaveLength(1);
  });

  it('should merge chunks sharing a messageId even when separated by other updates (R-10)', () => {
    const markdown = threadToMarkdown([
      { ...chunk('Hello'), content: { sessionUpdate: 'agent_message_chunk', messageId: 'm-1', content: { type: 'text', text: 'Hello' } } as Record<string, unknown> },
      { ...chunk(' world'), content: { sessionUpdate: 'agent_message_chunk', messageId: 'm-1', content: { type: 'text', text: ' world' } } as Record<string, unknown> },
    ]);

    expect(markdown).toContain('Hello world');
    expect(markdown.match(/## Assistant/g)).toHaveLength(1);
  });

  it('should merge thought chunks into a single thinking block (R-10)', () => {
    const markdown = threadToMarkdown([
      chunk('step one ', 'agent_thought_chunk'),
      chunk('step two', 'agent_thought_chunk'),
    ]);

    expect(markdown.match(/<thinking>/g)).toHaveLength(1);
    expect(markdown).toContain('step one step two');
  });

  it('should export the content channel result summary (R-11)', () => {
    const markdown = threadToMarkdown([
      {
        direction: 'output',
        content: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-content',
          kind: 'edit',
          title: 'Edit src/a.ts',
          status: 'completed',
          rawInput: { filePath: 'src/a.ts' },
          content: [
            { type: 'diff', path: 'src/a.ts', oldText: 'before', newText: 'after' },
          ],
        } as unknown as Record<string, unknown>,
      },
    ]);

    expect(markdown).toContain('**结果**');
    expect(markdown).toContain('```diff');
    expect(markdown).toContain('-before');
    expect(markdown).toContain('+after');
  });

  it('should not allow thinking text to close the thinking block (M-10)', () => {
    const markdown = threadToMarkdown([
      chunk('escape </thinking> here', 'agent_thought_chunk'),
    ]);

    expect(markdown).toContain('&lt;/thinking&gt;');
    expect(markdown.match(/<\/thinking>/g)).toHaveLength(1);
  });

  it('should not allow newlines in a tool title to break the heading (M-10)', () => {
    const markdown = threadToMarkdown([
      {
        direction: 'output',
        content: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-heading',
          title: 'line one\n# injected heading',
          status: 'completed',
        } as unknown as Record<string, unknown>,
      },
    ]);

    expect(markdown).toContain('### Tool: line one # injected heading');
    expect(markdown).not.toContain('\n# injected heading');
  });

  it('should order messages without timestamps deterministically (M-9)', () => {
    const markdown = threadToMarkdown([
      chunk('no-time-1'),
      { ...chunk('with-time'), createdAt: '2026-01-01T10:00:00.000Z' },
      chunk('no-time-2'),
    ]);

    expect(markdown).toContain('no-time-1');
    expect(markdown).toContain('no-time-2');
    expect(markdown.indexOf('no-time-1')).toBeLessThan(markdown.indexOf('with-time'));
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

  it('should create a blob download link and defer cleanup (M-11)', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadThreadMarkdown('session-1.md', '# hi');

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    // 不在 click 同步栈内回收，避免慢机器下载被取消
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });
});
