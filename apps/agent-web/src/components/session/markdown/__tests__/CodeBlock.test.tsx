import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import CodeBlock from '../CodeBlock';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe('CodeBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('T-CB1 should show language label, falling back to text', () => {
    const first = render(<CodeBlock code="const a = 1;" language="typescript" />);
    expect(screen.getByTestId('code-block-language').textContent).toBe('typescript');
    first.unmount();

    render(<CodeBlock code="plain" />);
    expect(screen.getByTestId('code-block-language').textContent).toBe('text');
  });

  it('T-CB2 should copy the exact code and toast success', async () => {
    render(<CodeBlock code={'line1\nline2'} />);

    fireEvent.click(screen.getByRole('button', { name: '复制代码' }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('line1\nline2');
      expect(toast.success).toHaveBeenCalledWith('已复制');
    });
  });

  it('T-CB3 should toast failure when clipboard rejects', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    render(<CodeBlock code="x" />);

    fireEvent.click(screen.getByRole('button', { name: '复制代码' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('复制失败');
    });
  });

  it('T-CB4 should toast failure when clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    render(<CodeBlock code="x" />);

    fireEvent.click(screen.getByRole('button', { name: '复制代码' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('复制失败');
    });
  });

  it('T-CB5 should toggle wrapping state per instance', () => {
    const { container } = render(<CodeBlock code="a very long line" language="typescript" />);

    const code = container.querySelector('code')!;
    expect(code.className).not.toContain('whitespace-pre-wrap');

    fireEvent.click(screen.getByRole('button', { name: '自动换行' }));

    expect(screen.getByRole('button', { name: '关闭自动换行' })).toBeDefined();
    expect(container.querySelector('code')!.className).toContain('whitespace-pre-wrap');
    expect(container.querySelector('code')!.className).toContain('break-all');

    fireEvent.click(screen.getByRole('button', { name: '关闭自动换行' }));
    expect(container.querySelector('code')!.className).not.toContain('whitespace-pre-wrap');
  });

  it('T-CB6 should keep toolbar shrink-0 and hide until hover on desktop', () => {
    render(<CodeBlock code="x" />);
    const block = screen.getByTestId('code-block');
    const toolbar = block.firstElementChild as HTMLElement;
    expect(toolbar.className).toContain('justify-between');
    const actions = toolbar.lastElementChild as HTMLElement;
    expect(actions.className).toContain('shrink-0');
    expect(actions.className).toContain('sm:opacity-0');
    expect(actions.className).toContain('sm:group-hover:opacity-100');
  });
});
