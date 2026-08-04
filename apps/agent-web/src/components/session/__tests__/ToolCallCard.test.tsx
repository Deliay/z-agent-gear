import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ToolCallCard from '../ToolCallCard';

function renderToolCall(message: Record<string, unknown>) {
  return render(
    <ToolCallCard
      messages={[{ content: message as never, createdAt: '2026-01-01T00:00:00Z' }]}
      expanded
    />,
  );
}

function renderCollapsedToolCall(message: Record<string, unknown>) {
  return render(
    <ToolCallCard
      messages={[{ content: message as never, createdAt: '2026-01-01T00:00:00Z' }]}
    />,
  );
}

describe('ToolCallCard kinds', () => {
  it('should render edit kind with diff content', () => {
    renderToolCall({
      sessionUpdate: 'tool_call',
      kind: 'edit',
      status: 'completed',
      title: 'Edit file',
      content: [
        { type: 'diff', path: 'src/a.ts', oldText: 'old line', newText: 'new line' },
      ],
    });

    expect(screen.getByText('src/a.ts')).toBeDefined();
    expect(screen.getByText('old line')).toBeDefined();
    expect(screen.getByText('new line')).toBeDefined();
  });

  it('should render delete kind with file path', () => {
    renderToolCall({
      sessionUpdate: 'tool_call',
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
      kind: 'think',
      status: 'completed',
      title: 'Think',
      rawOutput: { thoughts: 'reasoning step' },
    });

    expect(screen.getByText('reasoning step')).toBeDefined();
  });

  it('should render terminal content in degraded form', () => {
    renderToolCall({
      sessionUpdate: 'tool_call',
      kind: 'edit',
      status: 'completed',
      title: 'Edit file',
      content: [{ type: 'terminal', terminalId: 'term-1' }],
    });

    expect(screen.getByText(/term-1/)).toBeDefined();
  });
});

describe('ToolCallCard statuses', () => {
  it('should render in_progress with active color and files to modify', () => {
    const { container } = renderToolCall({
      sessionUpdate: 'tool_call',
      kind: 'edit',
      status: 'in_progress',
      title: 'Edit file',
      locations: [{ path: 'src/a.ts', line: 1 }],
    });

    expect(container.firstElementChild?.textContent).toBeDefined();
    expect(screen.getByText('src/a.ts')).toBeDefined();
    expect(container.firstElementChild?.className).toContain('bg-info/10');
  });

  it('should treat pending same as in_progress for execute kind', () => {
    const { container } = renderToolCall({
      sessionUpdate: 'tool_call',
      kind: 'execute',
      status: 'pending',
      title: 'Run command',
      rawInput: { command: 'npm test', workDir: '/repo' },
    });

    expect(screen.getByText(/npm test/)).toBeDefined();
    expect(container.firstElementChild?.className).toContain('bg-info/10');
  });

  it('should show ellipsis summary for in_progress and pending when collapsed', () => {
    const first = renderCollapsedToolCall({
      sessionUpdate: 'tool_call',
      kind: 'edit',
      status: 'in_progress',
      title: 'Edit file',
    });
    expect(screen.getByText(/\.\.\./)).toBeDefined();

    first.unmount();
    renderCollapsedToolCall({
      sessionUpdate: 'tool_call',
      kind: 'execute',
      status: 'pending',
      title: 'Run command',
    });
    expect(screen.getByText(/\.\.\./)).toBeDefined();
  });

  it('should show checkmark summary for completed when collapsed', () => {
    renderCollapsedToolCall({
      sessionUpdate: 'tool_call',
      kind: 'edit',
      status: 'completed',
      title: 'Edit file',
    });
    expect(screen.getByText(/✓/)).toBeDefined();
  });

  it('should show cross summary for failed when collapsed', () => {
    renderCollapsedToolCall({
      sessionUpdate: 'tool_call',
      kind: 'edit',
      status: 'failed',
      title: 'Edit file',
    });
    expect(screen.getByText(/✗/)).toBeDefined();
  });

  it('should default to in_progress when status is missing', () => {
    renderCollapsedToolCall({
      sessionUpdate: 'tool_call',
      kind: 'edit',
      title: 'Edit file',
    });
    expect(screen.getByText(/\.\.\./)).toBeDefined();
  });
});
