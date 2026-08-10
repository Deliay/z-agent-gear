import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BlackboardPanel from '../workflow/BlackboardPanel';
import type { BlackboardEntryData } from '@/graphql/workflow';

const entry = (key: string, value: string): BlackboardEntryData => ({
  key,
  value,
  updatedAt: '2026-08-08T00:00:00Z',
});

describe('BlackboardPanel 工作流黑板', () => {
  it('黑板默认折叠并显示数量，点击后展开内容', () => {
    render(
      <BlackboardPanel
        blackboard={[entry('k1-产物-甲', '内容甲'), entry('k2-产物-乙', '内容乙')]}
        trash={[]}
      />,
    );

    const toggle = screen.getByRole('button', { name: /工作流黑板（2）/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('k1-产物-甲')).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('k1-产物-甲')).toBeDefined();
    expect(screen.getByText('内容乙')).toBeDefined();

    // 再次点击折叠
    fireEvent.click(toggle);
    expect(screen.queryByText('k1-产物-甲')).toBeNull();
  });

  it('黑板条目内容以 Markdown 渲染', () => {
    render(<BlackboardPanel blackboard={[entry('k1', '**重点**：通过')]} trash={[]} />);
    fireEvent.click(screen.getByRole('button', { name: /工作流黑板/ }));

    expect(screen.getByText('重点').tagName).toBe('STRONG');
  });

  it('垃圾桶保持默认折叠并显示数量', () => {
    render(<BlackboardPanel blackboard={[]} trash={[entry('t1', '废弃内容')]} />);

    const trashToggle = screen.getByRole('button', { name: /垃圾桶（1）/ });
    expect(trashToggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('t1')).toBeNull();
  });

  it('垃圾桶内容同样以 Markdown 渲染', () => {
    render(<BlackboardPanel blackboard={[]} trash={[entry('t1', '**旧结论**')]} />);
    fireEvent.click(screen.getByRole('button', { name: /垃圾桶/ }));

    expect(screen.getByText('旧结论').tagName).toBe('STRONG');
  });
});
