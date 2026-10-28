import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ReadCard from '../ReadCard';
import FetchCard from '../FetchCard';
import SubAgentCard from '../SubAgentCard';
import { mergeToolCallMessages } from '../tool-call-state';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function merged(create: Record<string, unknown>, update: Record<string, unknown>) {
  return mergeToolCallMessages([
    { content: { sessionUpdate: 'tool_call', ...create } },
    { content: { sessionUpdate: 'tool_call_update', ...update } },
  ]);
}

describe('specialized tool cards keep creation data after completion', () => {
  it('T-RC ReadCard keeps the file list', () => {
    const toolCall = merged(
      {
        toolCallId: 'read-1',
        kind: 'read',
        title: 'Read files',
        rawInput: { filePath: 'src/a.ts' },
        locations: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
      },
      { toolCallId: 'read-1', status: 'completed', rawOutput: { output: 'file content' } },
    );

    render(<ReadCard toolCall={toolCall} expanded />);

    expect(screen.getByText('src/a.ts')).toBeDefined();
    expect(screen.getByText('src/b.ts')).toBeDefined();
    expect(screen.getByText('file content')).toBeDefined();
    expect(screen.getByTestId('acp-card-icon')).toBeDefined();
  });

  it('T-FC FetchCard keeps the URL', () => {
    const toolCall = merged(
      {
        toolCallId: 'fetch-1',
        kind: 'fetch',
        title: 'Fetch URL',
        rawInput: { url: 'https://example.com/page' },
      },
      { toolCallId: 'fetch-1', status: 'completed', rawOutput: { output: 'page body' } },
    );

    render(<FetchCard toolCall={toolCall} expanded />);

    expect(screen.getByText('https://example.com/page')).toBeDefined();
    expect(screen.getByText('page body')).toBeDefined();
  });

  it('T-SA SubAgentCard keeps prompt and description', () => {
    const toolCall = merged(
      {
        toolCallId: 'sub-1',
        kind: 'other',
        title: 'Sub agent',
        rawInput: { subagent_type: 'explore', description: 'Scan repo', prompt: 'Find entrypoints' },
      },
      { toolCallId: 'sub-1', status: 'completed', rawOutput: { output: 'done' } },
    );

    render(<SubAgentCard toolCall={toolCall} expanded />);

    expect(screen.getByText('Scan repo')).toBeDefined();
    expect(screen.getByText('Find entrypoints')).toBeDefined();
    expect(screen.getByText('done')).toBeDefined();
  });
});
