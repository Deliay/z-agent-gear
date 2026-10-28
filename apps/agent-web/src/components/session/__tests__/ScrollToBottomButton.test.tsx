import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ScrollToBottomButton from '../ScrollToBottomButton';

describe('ScrollToBottomButton', () => {
  it('T-SB1 should only render when visible', () => {
    const { rerender } = render(<ScrollToBottomButton visible={false} onClick={vi.fn()} />);
    expect(screen.queryByTestId('scroll-to-bottom')).toBeNull();

    rerender(<ScrollToBottomButton visible onClick={vi.fn()} />);
    expect(screen.getByTestId('scroll-to-bottom')).toBeDefined();
  });

  it('T-SB2 should show a dot when new messages arrived while paused', () => {
    const { rerender } = render(<ScrollToBottomButton visible onClick={vi.fn()} />);
    expect(screen.queryByTestId('scroll-to-bottom-dot')).toBeNull();

    rerender(<ScrollToBottomButton visible hasNewMessages onClick={vi.fn()} />);
    expect(screen.getByTestId('scroll-to-bottom-dot')).toBeDefined();
  });

  it('T-SB3 should trigger the scroll callback on click', () => {
    const onClick = vi.fn();
    render(<ScrollToBottomButton visible onClick={onClick} />);

    fireEvent.click(screen.getByRole('button', { name: '回到底部' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
