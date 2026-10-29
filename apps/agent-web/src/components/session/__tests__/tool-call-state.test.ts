import { describe, it, expect } from 'vitest';
import { mergeToolCallMessages, kindLabel, toolCallTitle, toolCallColor, toolCallHeaderTitle } from '../tool-call-state';

function message(content: Record<string, unknown>) {
  return { content };
}

describe('mergeToolCallMessages', () => {
  it('T-MERGE1 should take every field from the creation message', () => {
    const merged = mergeToolCallMessages([
      message({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Run tests',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'npm test' },
        locations: [{ path: 'src/a.ts', line: 3 }],
      }),
    ]);

    expect(merged).toMatchObject({
      toolCallId: 'tc-1',
      title: 'Run tests',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: 'npm test' },
      locations: [{ path: 'src/a.ts', line: 3 }],
    });
  });

  it('T-MERGE2 should keep creation fields on a sparse completion update', () => {
    const merged = mergeToolCallMessages([
      message({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Run tests',
        kind: 'execute',
        rawInput: { command: 'npm test' },
        locations: [{ path: 'src/a.ts', line: 3 }],
      }),
      message({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
        rawOutput: { output: 'ok' },
      }),
    ]);

    expect(merged.title).toBe('Run tests');
    expect(merged.kind).toBe('execute');
    expect(merged.rawInput).toEqual({ command: 'npm test' });
    expect(merged.locations).toEqual([{ path: 'src/a.ts', line: 3 }]);
    expect(merged.status).toBe('completed');
    expect(merged.rawOutput).toEqual({ output: 'ok' });
  });

  it('T-MERGE3 should preserve original values when update omits fields', () => {
    const merged = mergeToolCallMessages([
      message({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Edit file',
        kind: 'edit',
        name: 'edit',
        locations: [{ path: 'a.ts' }],
        rawInput: { filePath: 'a.ts' },
        content: [{ type: 'content', content: { type: 'text', text: 'a' } }],
      }),
      message({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' }),
    ]);

    expect(merged.title).toBe('Edit file');
    expect(merged.kind).toBe('edit');
    expect(merged.name).toBe('edit');
    expect(merged.locations).toEqual([{ path: 'a.ts' }]);
    expect(merged.rawInput).toEqual({ filePath: 'a.ts' });
    expect(merged.content).toEqual([{ type: 'content', content: { type: 'text', text: 'a' } }]);
  });

  it('T-MERGE4 should clear fields explicitly set to null', () => {
    const merged = mergeToolCallMessages([
      message({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Run tests',
        kind: 'execute',
        rawInput: { command: 'npm test' },
      }),
      message({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        title: null,
        kind: null,
        rawInput: null,
      }),
    ]);

    expect(merged.title).toBeUndefined();
    expect(merged.kind).toBeUndefined();
    expect(merged.rawInput).toBeUndefined();
    // 渲染层回退 kindLabel
    expect(toolCallTitle(merged)).toBe('Tool Call');
  });

  it('T-MERGE5 should replace fields when update carries values', () => {
    const merged = mergeToolCallMessages([
      message({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Old title',
        content: [{ type: 'content', content: { type: 'text', text: 'old' } }],
      }),
      message({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        title: 'New title',
        content: [{ type: 'content', content: { type: 'text', text: 'new' } }],
      }),
    ]);

    expect(merged.title).toBe('New title');
    expect(merged.content).toEqual([{ type: 'content', content: { type: 'text', text: 'new' } }]);
  });

  it('T-MERGE6 should take the latest carried status/content/rawOutput', () => {
    const merged = mergeToolCallMessages([
      message({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', status: 'pending' }),
      message({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'in_progress', rawOutput: { output: 'partial' } }),
      message({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', rawOutput: { output: 'final' } }),
    ]);

    expect(merged.status).toBe('completed');
    expect(merged.rawOutput).toEqual({ output: 'final' });
  });

  it('T-MERGE7 should not throw for updates without a creation message', () => {
    const merged = mergeToolCallMessages([
      message({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-9', status: 'completed' }),
    ]);

    expect(merged.toolCallId).toBe('tc-9');
    expect(merged.status).toBe('completed');
    expect(toolCallTitle(merged)).toBe('Tool Call');
    expect(merged.title).toBeUndefined();
  });

  it('T-MERGE8 should ignore non tool-call messages', () => {
    const merged = mergeToolCallMessages([
      message({ sessionUpdate: 'plan', entries: [] }),
      message({ sessionUpdate: 'usage_update', used: 1 }),
      message({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'Do it', status: 'in_progress' }),
      message({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }),
    ]);

    expect(merged.title).toBe('Do it');
    expect(merged.status).toBe('in_progress');
  });

  it('T-MERGE9 should take toolCallId from the first carrying message', () => {
    const merged = mergeToolCallMessages([
      message({ sessionUpdate: 'tool_call_update', toolCallId: 'first', status: 'completed' }),
      message({ sessionUpdate: 'tool_call_update', toolCallId: 'second', status: 'failed' }),
    ]);

    expect(merged.toolCallId).toBe('first');
  });

  it('T-MERGE10 should compute the same title before and after completion', () => {
    const created = mergeToolCallMessages([
      message({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', kind: 'execute', title: 'npm test' }),
    ]);
    const completed = mergeToolCallMessages([
      message({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', kind: 'execute', title: 'npm test' }),
      message({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' }),
    ]);

    expect(toolCallTitle(created)).toBe('npm test');
    expect(toolCallTitle(completed)).toBe('npm test');
  });

  it('should fall back to in_progress when status is explicitly cleared', () => {
    const merged = mergeToolCallMessages([
      message({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', status: 'pending' }),
      message({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: null }),
    ]);

    expect(merged.status).toBe('in_progress');
  });

  it('should keep an empty toolCallId when no message carries one', () => {
    const merged = mergeToolCallMessages([
      message({ sessionUpdate: 'tool_call', title: 'No id' }),
    ]);

    expect(merged.toolCallId).toBe('');
  });

  it('T-MERGE11 should fall back to name/kind instead of duplicating the generic title (R-3)', () => {
    const byName = mergeToolCallMessages([
      message({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', name: 'my_tool', status: 'completed' }),
    ]);
    expect(toolCallTitle(byName)).toBe('my_tool');

    const byKind = mergeToolCallMessages([
      message({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-2', kind: 'execute', status: 'completed' }),
    ]);
    expect(toolCallTitle(byKind)).toBe('Command');
  });

  it('T-MERGE12 should not build a duplicated "Tool Call: Tool Call" header (R-3)', () => {
    const missingCreation = mergeToolCallMessages([
      message({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-9', status: 'completed' }),
    ]);

    expect(toolCallHeaderTitle(missingCreation)).toBe('Tool Call');

    const withTitle = mergeToolCallMessages([
      message({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'npm test' }),
    ]);
    expect(toolCallHeaderTitle(withTitle)).toBe('Tool Call: npm test');
  });
});

describe('kindLabel / toolCallColor', () => {
  it('should label known and unknown kinds', () => {
    expect(kindLabel('execute')).toBe('Command');
    expect(kindLabel('edit')).toBe('Edit');
    expect(kindLabel('other')).toBe('Tool Call');
    expect(kindLabel('brand_new_kind')).toBe('brand_new_kind');
    expect(kindLabel(undefined)).toBe('Tool Call');
  });

  it('should map status to AcpCard semantic colors', () => {
    expect(toolCallColor('pending')).toBe('pending');
    expect(toolCallColor('in_progress')).toBe('active');
    expect(toolCallColor('completed')).toBe('completed');
    expect(toolCallColor('failed')).toBe('failed');
    expect(toolCallColor(undefined)).toBe('active');
  });
});
