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
    expect(screen.getByText('工作中')).toBeDefined();
  });

  it('should display idling status badge', () => {
    render(<SessionHeader session={baseSession} status="idling" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('空闲')).toBeDefined();
  });

  it('should display OpenCode label for opencode server type', () => {
    render(<SessionHeader session={baseSession} status="running" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('OpenCode')).toBeDefined();
  });

  it('should display GitHub Copilot label for github_copilot server type', () => {
    const copilotSession = { ...baseSession, acpServerType: 'github_copilot' };
    render(<SessionHeader session={copilotSession} status="running" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('GitHub Copilot')).toBeDefined();
  });

  it('should display MiMo Code label for mimo_code server type', () => {
    const mimoSession = { ...baseSession, acpServerType: 'mimo_code' };
    render(<SessionHeader session={mimoSession} status="running" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('MiMo Code')).toBeDefined();
  });

  it('should display Kimi Code label for kimi_code server type', () => {
    const kimiSession = { ...baseSession, acpServerType: 'kimi_code' };
    render(<SessionHeader session={kimiSession} status="running" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('Kimi Code')).toBeDefined();
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
    expect(screen.getByText('关闭')).toBeDefined();
  });

  it('should show Close button when status is idling', () => {
    render(<SessionHeader session={baseSession} status="idling" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('关闭')).toBeDefined();
  });

  it('should hide Close button when status is ended', () => {
    render(<SessionHeader session={baseSession} status="ended" onClose={noop} onDelete={noop} />);
    expect(screen.queryByText('关闭')).toBeNull();
  });

  it('should hide Close button when status is creating', () => {
    render(<SessionHeader session={baseSession} status="creating" onClose={noop} onDelete={noop} />);
    expect(screen.queryByText('关闭')).toBeNull();
  });

  it('should always show Delete button', () => {
    render(<SessionHeader session={baseSession} status="ended" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('删除')).toBeDefined();
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
    expect(screen.getByText('继续')).toBeDefined();
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
    expect(screen.queryByText('继续')).toBeNull();
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
    const btn = screen.getByText('继续') as HTMLButtonElement;
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
    const btn = screen.getByText('继续中...');
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
    expect(screen.getByText('继续中...')).toBeDefined();
    expect(screen.queryByText('继续')).toBeNull();
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
    screen.getByText('继续').click();
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('should call onClose when Close button clicked', async () => {
    const onClose = vi.fn();
    render(<SessionHeader session={baseSession} status="running" onClose={onClose} onDelete={noop} />);
    screen.getByText('关闭').click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('should call onDelete when Delete button clicked', async () => {
    const onDelete = vi.fn();
    render(<SessionHeader session={baseSession} status="running" onClose={noop} onDelete={onDelete} />);
    screen.getByText('删除').click();
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it('should display running status badge with pulse animation', () => {
    render(<SessionHeader session={baseSession} status="running" onClose={noop} onDelete={noop} />);
    const badge = screen.getByText('工作中');
    expect(badge.className).toContain('animate-pulse');
  });

  it('should display disconnected status badge', () => {
    render(<SessionHeader session={baseSession} status="disconnected" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('已断连')).toBeDefined();
  });

  it('should show Session fallback when session is null', () => {
    render(<SessionHeader session={null} status="connecting" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('Session')).toBeDefined();
  });
});
