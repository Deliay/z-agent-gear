import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ToolCallCard from '../ToolCallCard';
import { mergeToolCallMessages } from '../tool-call-state';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderToolCall(updates: Record<string, unknown> | Record<string, unknown>[]) {
  const list = Array.isArray(updates) ? updates : [updates];
  return render(
    <ToolCallCard
      toolCall={mergeToolCallMessages(list.map((content) => ({ content })))}
      expanded
    />,
  );
}

function renderCollapsedToolCall(updates: Record<string, unknown> | Record<string, unknown>[]) {
  const list = Array.isArray(updates) ? updates : [updates];
  return render(
    <ToolCallCard toolCall={mergeToolCallMessages(list.map((content) => ({ content })))} />,
  );
}

describe('ToolCallCard kinds', () => {
  it('should render edit kind with diff content', () => {
    renderToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'edit',
      status: 'completed',
      title: 'Edit file',
      content: [
        { type: 'diff', path: 'src/a.ts', oldText: 'old line', newText: 'new line' },
      ],
    });

    expect(screen.getByText('src/a.ts')).toBeDefined();
    expect(screen.getByTestId('diff-view').textContent).toContain('old line');
    expect(screen.getByTestId('diff-view').textContent).toContain('new line');
  });

  it('should render delete kind with file path', () => {
    renderToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'delete',
      status: 'completed',
      title: 'Delete file',
      rawInput: { filePath: 'src/old.ts' },
    });

    expect(screen.getByText('src/old.ts')).toBeDefined();
  });

  it('should render move kind with source and destination paths', () => {
    renderToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'move',
      status: 'completed',
      title: 'Move file',
      rawInput: { sourcePath: 'src/a.ts', destinationPath: 'src/b.ts' },
    });

    expect(screen.getByText('src/a.ts')).toBeDefined();
    expect(screen.getByText('src/b.ts')).toBeDefined();
    expect(screen.getByText('→')).toBeDefined();
  });

  it('should render search kind with query', () => {
    renderToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'search',
      status: 'completed',
      title: 'Search code',
      rawInput: { query: 'TODO' },
    });

    expect(screen.getByText(/TODO/)).toBeDefined();
  });

  it('should render think kind as collapsed thought block', () => {
    renderToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'think',
      status: 'completed',
      title: 'Think',
      rawOutput: { thoughts: 'reasoning step' },
    });

    expect(screen.getByText('reasoning step')).toBeDefined();
  });

  it('should render terminal content placeholder when no output is attached', () => {
    renderToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'edit',
      status: 'completed',
      title: 'Edit file',
      content: [{ type: 'terminal', terminalId: 'term-1' }],
    });

    expect(screen.getByText(/term-1/)).toBeDefined();
  });

  it('should render terminal output when content carries it', () => {
    renderToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'execute',
      status: 'completed',
      title: 'Run',
      content: [{ type: 'terminal', terminalId: 'term-2', output: '\u001b[31mfailed\u001b[0m' }],
    });

    expect(screen.getByTestId('terminal-output')).toBeDefined();
    expect(screen.getByTestId('terminal-output').textContent).toContain('failed');
  });

  it('should render output for a failed execute call instead of hiding it (R-4)', () => {
    renderToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-failed',
      kind: 'execute',
      status: 'failed',
      title: 'Run tests',
      rawInput: { command: 'npm test' },
      rawOutput: { output: 'stderr: boom' },
    });

    expect(screen.getByTestId('terminal-output').textContent).toContain('stderr: boom');
    expect(screen.getByText(/npm test/)).toBeDefined();
  });

  it('should keep the command when a failed execute call has no output (R-4)', () => {
    renderToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-failed-empty',
      kind: 'execute',
      status: 'failed',
      title: 'Run tests',
      rawInput: { command: 'npm test' },
    });

    expect(screen.getByText(/npm test/)).toBeDefined();
    expect(screen.getByText(/Command — failed/)).toBeDefined();
  });

  it('should keep file path and input diff for a failed edit (R-4)', () => {
    renderToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-edit-failed',
      kind: 'edit',
      status: 'failed',
      title: 'Edit file',
      rawInput: { filePath: 'src/a.ts', oldString: 'old', newString: 'new' },
    });

    expect(screen.getByText(/Editing: src\/a\.ts/)).toBeDefined();
    expect(screen.getByTestId('diff-view')).toBeDefined();
  });

  it('should show an input-unavailable placeholder when the creation event is missing (R-3)', () => {
    renderToolCall({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-missing',
      status: 'completed',
    });

    expect(screen.getByText('Tool Call')).toBeDefined();
    expect(screen.queryByText('Tool Call: Tool Call')).toBeNull();
    expect(screen.getByTestId('raw-section-输入').textContent).toContain('输入不可得');
  });
});

describe('ToolCallCard statuses', () => {
  it('should render in_progress with active color and files to modify', () => {
    const { container } = renderToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'edit',
      status: 'in_progress',
      title: 'Edit file',
      locations: [{ path: 'src/a.ts', line: 1 }],
    });

    expect(screen.getByText('src/a.ts')).toBeDefined();
    expect(container.firstElementChild?.className).toContain('bg-info/10');
  });

  it('should apply pending weakened style and waiting hint', () => {
    const { container } = renderToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'execute',
      status: 'pending',
      title: 'Run command',
      rawInput: { command: 'npm test', workDir: '/repo' },
    });

    expect(screen.getByText(/npm test/)).toBeDefined();
    expect(screen.getByText('等待确认')).toBeDefined();
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('border-dashed');
    expect(card.className).not.toContain('animate-pulse');
  });

  it('should wrap long commands instead of overflowing narrow panels', () => {
    const { container } = renderToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'execute',
      status: 'pending',
      title: 'Run command',
      rawInput: { command: `echo ${'x'.repeat(300)}` },
    });

    const pre = container.querySelector('pre')!;
    expect(pre.className).toContain('whitespace-pre-wrap');
    expect(pre.className).toContain('break-all');
  });

  it('should break long tool result text instead of overflowing', () => {
    renderToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'edit',
      status: 'completed',
      title: 'Edit file',
      content: [{ type: 'content', content: { type: 'text', text: 'y'.repeat(500) } }],
    });
    const text = screen.getByText('y'.repeat(500));
    expect(text.className).toContain('wrap-anywhere');
  });

  it('should break long thinking output instead of overflowing', () => {
    renderToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'think',
      status: 'completed',
      title: 'Think',
      rawOutput: { thoughts: 'z'.repeat(500) },
    });
    const text = screen.getByText('z'.repeat(500));
    expect(text.className).toContain('break-all');
  });

  it('should show ellipsis summary for in_progress and pending when collapsed', () => {
    const first = renderCollapsedToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'edit',
      status: 'in_progress',
      title: 'Edit file',
    });
    expect(screen.getByText(/\.\.\./)).toBeDefined();

    first.unmount();
    renderCollapsedToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-2',
      kind: 'execute',
      status: 'pending',
      title: 'Run command',
    });
    expect(screen.getByText(/\.\.\./)).toBeDefined();
  });

  it('should show checkmark summary for completed when collapsed', () => {
    renderCollapsedToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'edit',
      status: 'completed',
      title: 'Edit file',
    });
    expect(screen.getByText(/✓/)).toBeDefined();
  });

  it('should keep completed highlighted with softer same-family color', () => {
    const { container } = renderCollapsedToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'edit',
      status: 'completed',
      title: 'Edit file',
    });
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('bg-info/5');
    expect(card.className).toContain('border-info/40');
    expect(card.className).not.toContain('animate-pulse');
    expect(card.className).not.toContain('bg-muted');
  });

  it('should keep failed highlighted with destructive summary accent', () => {
    const { container } = renderCollapsedToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'edit',
      status: 'failed',
      title: 'Edit file',
    });
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('bg-info/5');
    expect(card.className).not.toContain('animate-pulse');
    expect(screen.getByText(/✗/).className).toContain('text-destructive');
  });

  it('should show cross summary for failed when collapsed', () => {
    renderCollapsedToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'edit',
      status: 'failed',
      title: 'Edit file',
    });
    expect(screen.getByText(/✗/)).toBeDefined();
  });

  it('should default to in_progress when status is missing', () => {
    renderCollapsedToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'edit',
      title: 'Edit file',
    });
    expect(screen.getByText(/\.\.\./)).toBeDefined();
  });
});

describe('ToolCallCard lifecycle consistency', () => {
  const created = {
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-1',
    kind: 'execute',
    title: 'npm test',
    rawInput: { command: 'npm test -- --run', workDir: '/repo' },
    locations: [{ path: 'src/a.test.ts', line: 10 }],
  };
  const completedSparse = {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-1',
    status: 'completed',
    rawOutput: { output: 'all green' },
  };

  it('T-TC should keep title/kind/input after a sparse completion update', () => {
    renderToolCall([created, completedSparse]);

    expect(screen.getByText('Tool Call: npm test')).toBeDefined();
    expect(screen.queryByText(/Tool Call: other/)).toBeNull();
    expect(screen.queryByText(/other — completed/)).toBeNull();
    expect(screen.getByText(/npm test -- --run/)).toBeDefined();
  });

  it('T-TC should show the type icon before the title', () => {
    renderToolCall([created, completedSparse]);
    expect(screen.getByTestId('acp-card-icon')).toBeDefined();
  });

  it('T-TC should allow inspecting raw input and output', () => {
    renderToolCall([created, completedSparse]);

    fireEvent.click(screen.getByRole('button', { name: '查看原始输入' }));
    expect(screen.getByTestId('raw-section-输入')).toBeDefined();
    expect(screen.getByTestId('raw-section-输入').textContent).toContain('"command": "npm test -- --run"');

    fireEvent.click(screen.getByRole('button', { name: '查看原始输出' }));
    expect(screen.getByTestId('raw-section-输出').textContent).toContain('"output": "all green"');
  });

  it('T-TC should truncate very large raw input', () => {
    const huge = { lines: Array.from({ length: 600 }, (_, i) => `line-${i}`) };
    renderToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'other',
      status: 'completed',
      title: 'Huge',
      rawInput: huge,
    });

    fireEvent.click(screen.getByRole('button', { name: '查看原始输入' }));
    expect(screen.getByText(/内容过长，仅展示前 500 行/)).toBeDefined();
  });
});

describe('ToolCallCard content types', () => {
  it('should render image content', () => {
    renderToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'other',
      status: 'completed',
      title: 'Screenshot',
      content: [{ type: 'content', content: { type: 'image', data: 'YWJj', mimeType: 'image/png' } }],
    });

    const img = screen.getByAltText('工具产出图片') as HTMLImageElement;
    expect(img.src).toContain('data:image/png;base64,YWJj');
  });

  it('should render resource links in a new window', () => {
    renderToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'other',
      status: 'completed',
      title: 'Resource',
      content: [{ type: 'content', content: { type: 'resource_link', uri: 'https://example.com/doc', name: 'Doc' } }],
    });

    const link = screen.getByText('Doc').closest('a')!;
    expect(link.getAttribute('href')).toBe('https://example.com/doc');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('should degrade unknown kinds to title + status + raw data', () => {
    renderToolCall({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      kind: 'brand_new_kind',
      status: 'completed',
      title: 'Mystery tool',
      rawInput: { foo: 'bar' },
    });

    expect(screen.getByText('Tool Call: Mystery tool')).toBeDefined();
    expect(screen.getByText(/brand_new_kind — completed/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '查看原始输入' }));
    expect(screen.getByTestId('raw-section-输入').textContent).toContain('"foo": "bar"');
  });
});
