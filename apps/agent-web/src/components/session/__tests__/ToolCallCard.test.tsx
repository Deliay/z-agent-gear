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
