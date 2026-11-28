import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReadCard from '../ReadCard';
import FetchCard from '../FetchCard';
import SubAgentCard from '../SubAgentCard';
import ThoughtBlock from '../ThoughtBlock';
import UsageCard from '../UsageCard';
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

    expect(screen.getByText('读取文件')).toBeDefined();
    expect(screen.getByText('已读取文件')).toBeDefined();
    expect(screen.getByText('文件内容')).toBeDefined();
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

    expect(screen.getByText('抓取网页')).toBeDefined();
    expect(screen.getByText('链接地址')).toBeDefined();
    expect(screen.getByText('返回结果')).toBeDefined();
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

    expect(screen.getByText('提示词')).toBeDefined();
    expect(screen.getByText('执行结果')).toBeDefined();
    expect(screen.getByText('Scan repo')).toBeDefined();
    expect(screen.getByText('Find entrypoints')).toBeDefined();
    expect(screen.getByText('done')).toBeDefined();
  });

  it('ThoughtBlock renders Chinese title and tabular-nums timestamp', () => {
    render(
      <ThoughtBlock
        chunks={[{ content: { type: 'text', text: '正在分析依赖关系' } }]}
        createdAt="2026-05-19T10:00:00.000Z"
        expanded
      />,
    );

    expect(screen.getByText('思考过程')).toBeDefined();
    expect(screen.getByText('正在分析依赖关系')).toBeDefined();
  });

  it('UsageCard renders Chinese labels with Token casing and tabular-nums', () => {
    render(
      <UsageCard
        data={{
          used: 1200,
          size: 128000,
          cost: { amount: 0.0123, currency: 'USD' },
        }}
      />,
    );

    expect(screen.getByText('用量统计')).toBeDefined();
    expect(screen.getByText('本次消耗 1,200 Token')).toBeDefined();
    fireEvent.click(screen.getByText('用量统计'));
    expect(screen.getByText('上下文窗口')).toBeDefined();
    expect(screen.getByText('费用')).toBeDefined();
    expect(screen.getByText('1,200 / 128,000 Token')).toBeDefined();
  });
});
