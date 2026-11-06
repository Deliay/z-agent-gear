// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));
vi.mock('@apollo/client/react', () => ({
  useQuery: () => ({
    data: {
      homeOverview: {
        sessionReviews: [
          { id: 'rev-p', sessionId: 'sess-11111111', files: ['a.ts'], status: 'PENDING', fileReviews: null, comment: null, cancelReason: null, createdAt: '', resolvedAt: null },
          { id: 'rev-a', sessionId: 'sess-22222222', files: ['b.ts', 'c.ts'], status: 'APPROVED', fileReviews: {}, comment: 'ok', cancelReason: null, createdAt: '', resolvedAt: '' },
        ],
      },
    },
    loading: false,
  }),
}));

import ReviewSection from '../ReviewSection';

describe('ReviewSection（T-RSEC）', () => {
  beforeEach(() => cleanup());

  it('T-RSEC1 待 Review 实时包含 PENDING；T-RSEC2 终态默认折叠', () => {
    render(<ReviewSection />);
    // 待 Review 默认展开
    const pendingToggle = screen.getByTestId('review-section-pending-toggle');
    expect(pendingToggle.textContent).toContain('待 Review（1）');
    const pendingItem = screen.getByTestId('review-section-item');
    expect(pendingItem.getAttribute('data-review-status')).toBe('PENDING');

    // 已 Review 默认折叠（条目不可见）
    const resolvedToggle = screen.getByTestId('review-section-resolved-toggle');
    expect(resolvedToggle.textContent).toContain('已 Review（1）');
    expect(screen.getAllByTestId('review-section-item')).toHaveLength(1);

    fireEvent.click(resolvedToggle);
    expect(screen.getAllByTestId('review-section-item')).toHaveLength(2);
  });

  it('T-RSEC3 点击深链跳转 ?review=', () => {
    render(<ReviewSection />);
    fireEvent.click(screen.getByTestId('review-section-item'));
    expect(mockNavigate).toHaveBeenCalledWith('/sessions/sess-11111111?review=rev-p');
  });

  it('T-RSEC4 空分区整体不渲染（注入空数据）', () => {
    render(<ReviewSection sessionReviews={[]} />);
    expect(screen.queryByTestId('review-section')).toBeNull();
  });
});
