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

  it('should display running status badge', () => {
    render(<SessionHeader session={baseSession} status="running" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('running')).toBeDefined();
  });

  it('should display idling status badge', () => {
    render(<SessionHeader session={baseSession} status="idling" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('idling')).toBeDefined();
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

  it('should show Close button when status is running', () => {
    render(<SessionHeader session={baseSession} status="running" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('Close')).toBeDefined();
  });

  it('should show Close button when status is idling', () => {
    render(<SessionHeader session={baseSession} status="idling" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('Close')).toBeDefined();
  });

  it('should hide Close button when status is ended', () => {
    render(<SessionHeader session={baseSession} status="ended" onClose={noop} onDelete={noop} />);
    expect(screen.queryByText('Close')).toBeNull();
  });

  it('should hide Close button when status is creating', () => {
    render(<SessionHeader session={baseSession} status="creating" onClose={noop} onDelete={noop} />);
    expect(screen.queryByText('Close')).toBeNull();
  });

  it('should always show Delete button', () => {
    render(<SessionHeader session={baseSession} status="ended" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('Delete')).toBeDefined();
  });

  it('should show Continue button when status is ended', () => {
    render(
      <SessionHeader
        session={baseSession}
        status="ended"
        onClose={noop}
        onDelete={noop}
        onContinue={noop}
        controllerOnline={true}
      />,
    );
    expect(screen.getByText('Continue')).toBeDefined();
  });

  it('should hide Continue button when status is not ended', () => {
    render(
      <SessionHeader
        session={baseSession}
        status="running"
        onClose={noop}
        onDelete={noop}
        onContinue={noop}
        controllerOnline={true}
      />,
    );
    expect(screen.queryByText('Continue')).toBeNull();
  });

  it('should disable Continue button when controller is offline', () => {
    render(
      <SessionHeader
        session={baseSession}
        status="ended"
        onClose={noop}
        onDelete={noop}
        onContinue={noop}
        controllerOnline={false}
      />,
    );
    const btn = screen.getByText('Continue') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('should disable Continue button when resuming', () => {
    render(
      <SessionHeader
        session={baseSession}
        status="ended"
        onClose={noop}
        onDelete={noop}
        onContinue={noop}
        controllerOnline={true}
        resuming={true}
      />,
    );
    const btn = screen.getByText('Continuing...');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('should show Continuing... text when resuming', () => {
    render(
      <SessionHeader
        session={baseSession}
        status="ended"
        onClose={noop}
        onDelete={noop}
        onContinue={noop}
        controllerOnline={true}
        resuming={true}
      />,
    );
    expect(screen.getByText('Continuing...')).toBeDefined();
    expect(screen.queryByText('Continue')).toBeNull();
  });

  it('should call onContinue when Continue clicked', () => {
    const onContinue = vi.fn();
    render(
      <SessionHeader
        session={baseSession}
        status="ended"
        onClose={noop}
        onDelete={noop}
        onContinue={onContinue}
        controllerOnline={true}
      />,
    );
    screen.getByText('Continue').click();
    expect(onContinue).toHaveBeenCalledOnce();
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
