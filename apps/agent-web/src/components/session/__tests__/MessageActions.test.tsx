import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import MessageActions from '../MessageActions';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

describe('MessageActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('T-MA1 should copy the raw markdown content', async () => {
    render(<MessageActions content={'# Title\n\n**bold**'} />);

    fireEvent.click(screen.getByRole('button', { name: '复制 Markdown' }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('# Title\n\n**bold**');
      expect(toast.success).toHaveBeenCalledWith('已复制');
    });
  });

  it('T-MA2 should copy rendered plain text when available', async () => {
    const getPlainText = vi.fn(() => 'Title bold');
    render(<MessageActions content={'# Title\n\n**bold**'} getPlainText={getPlainText} />);

    fireEvent.click(screen.getByRole('button', { name: '复制纯文本' }));

    await waitFor(() => {
      expect(getPlainText).toHaveBeenCalled();
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Title bold');
    });
  });

  it('T-MA3 should toast failure when the clipboard rejects', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    render(<MessageActions content="text" />);

    fireEvent.click(screen.getByRole('button', { name: '复制 Markdown' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('复制失败');
    });
  });

  it('T-MA4 should be hover-revealed on desktop but reachable on focus', () => {
    render(<MessageActions content="text" />);
    const bar = screen.getByTestId('message-actions');
    expect(bar.className).toContain('sm:opacity-0');
    expect(bar.className).toContain('sm:group-hover:opacity-100');
    expect(bar.className).toContain('sm:group-focus-within:opacity-100');
  });

  it('T-MA5 should not report success when there is nothing to copy (M-12)', async () => {
    render(<MessageActions content="   " />);

    fireEvent.click(screen.getByRole('button', { name: '复制 Markdown' }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith('没有可复制的内容');
    });
  });
});
