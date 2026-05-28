import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SessionHeader from './SessionHeader';
import { useIsMobile } from '../../hooks/useIsMobile';

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(),
}));

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('SessionHeader mobile', () => {
  const baseSession = {
    id: 'sess-1',
    userId: 'user-1',
    controllerId: 'ctrl-1',
    controllerName: 'My Dev Machine',
    acpServerType: 'opencode',
    status: 'running',
    externalSessionId: null,
    cwd: '/home/user/project',
    createdAt: '2026-05-19T10:00:00.000Z',
    updatedAt: '2026-05-19T10:00:00.000Z',
    endedAt: null,
  };

  const noop = vi.fn();

  beforeEach(() => {
    vi.mocked(useIsMobile).mockReset();
  });

  it('should show MobileBackButton on mobile viewport', () => {
    vi.mocked(useIsMobile).mockReturnValue(true);
    renderWithRouter(<SessionHeader session={baseSession} status="idling" onClose={noop} onDelete={noop} />);
    const backBtn = screen.getByText('← 返回');
    expect(backBtn).toBeDefined();
  });

  it('should hide ACP server type on mobile', () => {
    vi.mocked(useIsMobile).mockReturnValue(true);
    renderWithRouter(<SessionHeader session={baseSession} status="running" onClose={noop} onDelete={noop} />);
    expect(screen.queryByText('OpenCode')).toBeNull();
  });

  it('should show ACP server type on desktop', () => {
    vi.mocked(useIsMobile).mockReturnValue(false);
    renderWithRouter(<SessionHeader session={baseSession} status="running" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('OpenCode')).toBeDefined();
  });

  it('should show back button with text 返回', () => {
    vi.mocked(useIsMobile).mockReturnValue(true);
    renderWithRouter(<SessionHeader session={baseSession} status="idling" onClose={noop} onDelete={noop} />);
    const backBtn = screen.getByText('← 返回');
    expect(backBtn.closest('button')).toBeTruthy();
  });
});
