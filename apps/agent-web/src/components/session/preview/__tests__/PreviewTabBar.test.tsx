// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PreviewTabBar, REVIEW_STATUS_CLASSES } from '../PreviewTabBar';
import type { PreviewTab } from '../../../../stores/preview';

const tabs: PreviewTab[] = [
  { id: 't1', kind: 'file', filePath: 'src/a.ts', pinned: true },
  { id: 't2', kind: 'file', filePath: 'src/b.ts', pinned: false },
  { id: 't3', kind: 'review', reviewId: 'rev-1' },
];

describe('PreviewTabBar（T-TABBAR / 返工 A2 状态色）', () => {
  it('A2 四态色：data-review-status 逐态映射（PENDING 黄 / APPROVED 绿 / REJECTED 红 / COMMENTED·CANCELLED 灰）', () => {
    expect(REVIEW_STATUS_CLASSES.PENDING).toContain('yellow');
    expect(REVIEW_STATUS_CLASSES.APPROVED).toContain('green');
    expect(REVIEW_STATUS_CLASSES.REJECTED).toContain('red');
    expect(REVIEW_STATUS_CLASSES.COMMENTED).toContain('muted');
    expect(REVIEW_STATUS_CLASSES.CANCELLED).toContain('italic');

    render(
      <PreviewTabBar
        tabs={tabs}
        activeTabId="t1"
        reviewStatuses={{ 'rev-1': 'APPROVED' }}
        onActivate={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('review-tab-status')).toHaveAttribute('data-review-status', 'APPROVED');
  });

  it('常开/共享预览标识与激活态', () => {
    render(
      <PreviewTabBar tabs={tabs} activeTabId="t2" reviewStatuses={{}} onActivate={vi.fn()} onClose={vi.fn()} />,
    );
    const items = screen.getAllByTestId('preview-tab');
    expect(items[0]).toHaveAttribute('data-active', 'false');
    expect(items[0].textContent).toContain('常开');
    expect(items[1]).toHaveAttribute('data-active', 'true');
    expect(items[1].textContent).toContain('预览');
    expect(items[2]).toHaveAttribute('data-tab-kind', 'review');
  });

  it('点击标签激活 / 关闭', () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    render(<PreviewTabBar tabs={tabs} activeTabId="t1" reviewStatuses={{}} onActivate={onActivate} onClose={onClose} />);
    fireEvent.click(screen.getAllByTestId('preview-tab')[1].querySelector('button')!);
    expect(onActivate).toHaveBeenCalledWith('t2');
    fireEvent.click(screen.getAllByTestId('preview-tab-close')[1]);
    expect(onClose).toHaveBeenCalledWith('t2');
  });

  it('空标签不渲染', () => {
    render(<PreviewTabBar tabs={[]} activeTabId={null} reviewStatuses={{}} onActivate={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByTestId('preview-tab-bar')).toBeNull();
    cleanup();
  });
});
