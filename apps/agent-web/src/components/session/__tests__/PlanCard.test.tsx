import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PlanCard from '../PlanCard';
import PlanFloatingCard from '../PlanFloatingCard';

function planMessages(entries: Array<{ content: string; status: string; priority?: string }>) {
  return [
    {
      content: {
        sessionUpdate: 'plan',
        entries: entries.map((entry) => ({ priority: 'medium', ...entry })),
      } as Record<string, unknown>,
      createdAt: '2026-01-01T00:00:00Z',
    },
  ];
}

describe('PlanCard', () => {
  it('T-PC1 should strike through completed entries', () => {
    render(<PlanCard messages={planMessages([
      { content: 'done task', status: 'completed' },
      { content: 'todo task', status: 'pending' },
    ])} />);

    expect(screen.getByText('done task').className).toContain('line-through');
    expect(screen.getByText('todo task').className).not.toContain('line-through');
  });

  it('T-PC2 should show 全部完成 when all entries are completed', () => {
    render(<PlanCard messages={planMessages([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
    ])} />);

    fireEvent.click(screen.getByText('Plan'));
    expect(screen.getByText('全部完成')).toBeDefined();
  });

  it('T-PC3 should show x/y when partially completed', () => {
    render(<PlanCard messages={planMessages([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ])} />);

    fireEvent.click(screen.getByText('Plan'));
    expect(screen.getByText('1/3')).toBeDefined();
  });

  it('T-PC4 should show N 项任务 when nothing is completed', () => {
    render(<PlanCard messages={planMessages([
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'pending' },
    ])} />);

    fireEvent.click(screen.getByText('Plan'));
    expect(screen.getByText('2 项任务')).toBeDefined();
  });
});

describe('PlanFloatingCard', () => {
  it('should sync summary and strike-through with PlanCard', () => {
    render(<PlanFloatingCard messages={planMessages([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'pending' },
    ])} />);

    expect(screen.getByText('1/2')).toBeDefined();

    fireEvent.click(screen.getByText('Plan'));
    expect(screen.getByText('a').className).toContain('line-through');
  });
});
