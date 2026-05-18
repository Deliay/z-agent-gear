import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import SessionHeader from './SessionHeader';

describe('SessionHeader', () => {
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

  it('should display controller name', () => {
    render(<SessionHeader session={baseSession} status="running" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('My Dev Machine')).toBeDefined();
  });

  it('should display status badge', () => {
    render(<SessionHeader session={baseSession} status="running" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('running')).toBeDefined();
  });

  it('should display acpServerType badge', () => {
    render(<SessionHeader session={baseSession} status="running" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('opencode')).toBeDefined();
  });

  it('should display cwd', () => {
    render(<SessionHeader session={baseSession} status="running" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('/home/user/project')).toBeDefined();
  });

  it('should display formatted createdAt', () => {
    render(<SessionHeader session={baseSession} status="running" onClose={noop} onDelete={noop} />);
    expect(screen.getByText(/2026/)).toBeDefined();
  });

  it('should show Close button when status is not ended', () => {
    render(<SessionHeader session={baseSession} status="running" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('Close')).toBeDefined();
  });

  it('should hide Close button when status is ended', () => {
    render(<SessionHeader session={baseSession} status="ended" onClose={noop} onDelete={noop} />);
    expect(screen.queryByText('Close')).toBeNull();
  });

  it('should always show Delete button', () => {
    render(<SessionHeader session={baseSession} status="ended" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('Delete')).toBeDefined();
  });

  it('should call onClose when Close button clicked', async () => {
    const onClose = vi.fn();
    render(<SessionHeader session={baseSession} status="running" onClose={onClose} onDelete={noop} />);
    screen.getByText('Close').click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('should call onDelete when Delete button clicked', async () => {
    const onDelete = vi.fn();
    render(<SessionHeader session={baseSession} status="running" onClose={noop} onDelete={onDelete} />);
    screen.getByText('Delete').click();
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it('should show Session fallback when session is null', () => {
    render(<SessionHeader session={null} status="connecting" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('Session')).toBeDefined();
  });
});
