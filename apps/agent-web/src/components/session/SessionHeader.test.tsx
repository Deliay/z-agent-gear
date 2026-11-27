import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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

  it('should display DeepSeek Harness label for deepseek_harness server type', () => {
    const deepseekSession = { ...baseSession, acpServerType: 'deepseek_harness' };
    render(<SessionHeader session={deepseekSession} status="running" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('DeepSeek Harness')).toBeDefined();
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

  it('should show Continue button instead of Close when status is disconnected', () => {
    render(<SessionHeader session={baseSession} status="disconnected" onClose={noop} onDelete={noop} onContinue={noop} controllerOnline />);
    expect(screen.queryByText('关闭')).toBeNull();
    expect(screen.getByText('继续')).toBeDefined();
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

  it('should display running status dot with pulse animation', () => {
    render(<SessionHeader session={baseSession} status="running" onClose={noop} onDelete={noop} />);
    const dot = screen.getByTestId('session-status-dot');
    expect(dot.className).toContain('animate-pulse');
    expect(dot.className).toContain('bg-info');
  });

  it('T-SESS-H1: 单行 h-12 顶栏 + 状态圆点 + 所属工作区/分支', () => {
    render(
      <SessionHeader
        session={{ ...baseSession, worktreeBranch: 'feat/ui-rework' }}
        status="running"
        onClose={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByTestId('session-header').className).toContain('h-12');
    // 状态圆点（非徽标）：容器内仅圆点 + sr-only 文案
    const badge = screen.getByTestId('session-status-badge');
    expect(badge.className).not.toContain('rounded-full bg-');
    expect(screen.getByTestId('session-status-dot')).toBeInTheDocument();
    expect(screen.getByTestId('session-workspace')).toHaveTextContent('project');
    expect(screen.getByTestId('session-branch')).toHaveTextContent('feat/ui-rework');
  });

  it('T-SESS-H1: 顶栏标题渲染会话标题（Session.title），控制器名仅收进环境胶囊', () => {
    render(
      <SessionHeader
        session={{ ...baseSession, title: '修复登录流程' }}
        status="running"
        onClose={noop}
        onDelete={noop}
      />,
    );
    const title = screen.getByTestId('session-title');
    expect(title).toHaveTextContent('修复登录流程');
    expect(title).not.toHaveTextContent('My Dev Machine');
    expect(screen.getByTestId('session-env-capsule')).toHaveTextContent('控制器：My Dev Machine');
  });

  it('T-SESS-H1: 环境胶囊包含控制器 / Harness / 工作目录 / 时间', () => {
    render(<SessionHeader session={baseSession} status="running" onClose={noop} onDelete={noop} />);
    const capsule = screen.getByTestId('session-env-capsule');
    expect(capsule).toHaveTextContent('控制器：My Dev Machine');
    expect(capsule).toHaveTextContent('OpenCode');
    expect(capsule).toHaveTextContent('/home/user/project');
    expect(capsule.getAttribute('title')).toContain('控制器');
  });

  it('should display disconnected status badge', () => {
    render(<SessionHeader session={baseSession} status="disconnected" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('已断连')).toBeDefined();
  });

  it('should show 会话 fallback when session is null', () => {
    render(<SessionHeader session={null} status="connecting" onClose={noop} onDelete={noop} />);
    expect(screen.getByText('会话')).toBeDefined();
  });
});

describe('SessionHeader - 能力入口与门控', () => {
  const baseSession = {
    id: 'sess-1',
    userId: 'user-1',
    controllerId: 'ctrl-1',
    controllerName: 'My Dev Machine',
    acpServerType: 'opencode',
    status: 'ended',
    externalSessionId: null,
    cwd: '/home/user/project',
    createdAt: '2026-05-19T10:00:00.000Z',
    updatedAt: '2026-05-19T10:00:00.000Z',
    endedAt: null,
  };

  function makeCapabilities(blockedIds: string[]) {
    return {
      features: blockedIds.map((id) => ({ id, status: 'unsupported' as const, detail: `未声明 ${id}` })),
      hasSnapshot: true,
      status: (id: string) => (blockedIds.includes(id) ? 'unsupported' as const : 'supported' as const),
      detail: (id: string) => (blockedIds.includes(id) ? `未声明 ${id}` : null),
      isBlocked: (id: string) => blockedIds.includes(id),
    };
  }

  it('渲染能力清单入口按钮', () => {
    render(
      <SessionHeader
        session={baseSession}
        status="ended"
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onContinue={vi.fn()}
        controllerOnline
        capabilities={makeCapabilities([])}
      />,
    );
    expect(screen.getByLabelText('能力清单')).toBeDefined();
  });

  it('T-W11: resume+load 均 unsupported 时「继续」禁用', () => {
    render(
      <SessionHeader
        session={baseSession}
        status="ended"
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onContinue={vi.fn()}
        controllerOnline
        capabilities={makeCapabilities(['session.resume', 'session.load'])}
      />,
    );

    const continueButton = screen.getByText('继续') as HTMLButtonElement;
    expect(continueButton.disabled).toBe(true);
    expect(continueButton.getAttribute('title')).toBe('当前 Agent 不支持会话恢复');
  });

  it('T-W11b: 仅 load supported（resume unsupported）时「继续」可用', () => {
    render(
      <SessionHeader
        session={baseSession}
        status="ended"
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onContinue={vi.fn()}
        controllerOnline
        capabilities={makeCapabilities(['session.resume'])}
      />,
    );

    const continueButton = screen.getByText('继续') as HTMLButtonElement;
    expect(continueButton.disabled).toBe(false);
  });

  it('should render export button and trigger callback', () => {
    const onExport = vi.fn();
    render(<SessionHeader session={baseSession} status="running" onClose={vi.fn()} onDelete={vi.fn()} onExport={onExport} />);

    fireEvent.click(screen.getByRole('button', { name: '导出对话' }));
    expect(onExport).toHaveBeenCalledOnce();
  });

  it('should hide export button when no callback is provided', () => {
    render(<SessionHeader session={baseSession} status="running" onClose={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '导出对话' })).toBeNull();
  });
});

describe('SessionHeader 归档入口（T-WEB1）', () => {
  const baseSession = {
    id: 'sess-1',
    userId: 'user-1',
    controllerId: 'ctrl-1',
    controllerName: 'My Dev Machine',
    acpServerType: 'opencode',
    status: 'ended',
    externalSessionId: null,
    cwd: '/home/user/project',
    createdAt: '2026-05-19T10:00:00.000Z',
    updatedAt: '2026-05-19T10:00:00.000Z',
    endedAt: '2026-05-19T11:00:00.000Z',
  };

  it('未传 onArchiveToggle 时不渲染归档按钮（工作流节点会话口径）', () => {
    render(<SessionHeader session={baseSession} status="ended" onClose={vi.fn()} onDelete={vi.fn()} />);

    expect(screen.queryByRole('button', { name: '归档' })).toBeNull();
    expect(screen.queryByRole('button', { name: '取消归档' })).toBeNull();
  });

  it('传入 onArchiveToggle 时渲染「归档」按钮，位置在「导出对话」之后', () => {
    const onArchiveToggle = vi.fn();
    render(
      <SessionHeader
        session={baseSession}
        status="ended"
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onExport={vi.fn()}
        onArchiveToggle={onArchiveToggle}
      />,
    );

    const labels = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'));
    expect(labels.indexOf('归档')).toBeGreaterThan(labels.indexOf('导出对话'));

    fireEvent.click(screen.getByRole('button', { name: '归档' }));
    expect(onArchiveToggle).toHaveBeenCalledOnce();
  });

  it('已归档会话显示「已归档」徽标并把入口切换为「取消归档」', () => {
    render(
      <SessionHeader
        session={{ ...baseSession, archived: true }}
        status="ended"
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onArchiveToggle={vi.fn()}
      />,
    );

    expect(screen.getByText('已归档')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消归档' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '归档' })).toBeNull();
  });

  it('归档进行中（archiving）按钮禁用', () => {
    render(
      <SessionHeader
        session={baseSession}
        status="ended"
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onArchiveToggle={vi.fn()}
        archiving
      />,
    );

    expect(screen.getByRole('button', { name: '归档' })).toBeDisabled();
  });
});

describe('SessionHeader 响应式操作收纳（T-SESS-H2，锚点保留 / 行为改断点驱动）', () => {
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

  it('T-SESS-H2: 移除 TOOLBAR_MIN_INFO_WIDTH 被动折叠；窄屏锚点与桌面工具栏同批渲染', () => {
    render(<SessionHeader session={baseSession} status="running" onClose={vi.fn()} onDelete={vi.fn()} onExport={vi.fn()} splitMode="vertical" onSplitModeChange={vi.fn()} />);
    // 锚点保留（D5），但不再由测量宽度切换——两者同时存在于 DOM，由 CSS 断点决定展示
    expect(screen.getByTestId('session-header-overflow')).toBeInTheDocument();
    expect(screen.getByTestId('session-header-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('split-mode-buttons')).toBeInTheDocument();

    // resize 不再触发收纳状态切换
    Object.defineProperty(screen.getByTestId('session-header'), 'clientWidth', { configurable: true, get: () => 480 });
    fireEvent(window, new Event('resize'));
    expect(screen.getByTestId('session-header-toolbar')).toBeInTheDocument();
  });

  it('T-SESS-H2: 源码层移除 TOOLBAR_MIN_INFO_WIDTH 机制', () => {
    const sources = import.meta.glob('./SessionHeader.tsx', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const text = Object.values(sources)[0] ?? '';
    expect(text).not.toContain('TOOLBAR_MIN_INFO_WIDTH');
    expect(text).not.toContain('toolbarNaturalWidthRef');
  });

  it('下拉承载完整操作并触发导出', async () => {
    const onExport = vi.fn();
    render(<SessionHeader session={baseSession} status="running" onClose={vi.fn()} onDelete={vi.fn()} onExport={onExport} onArchiveToggle={vi.fn()} splitMode="vertical" onSplitModeChange={vi.fn()} live onLiveChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId('session-header-overflow'));
    expect(await screen.findByTestId('session-header-overflow-menu')).toBeInTheDocument();
    const menu = screen.getByTestId('session-header-overflow-menu');
    for (const label of ['能力清单', '仅会话', '左右分栏', '上下分栏', '实况跟随', '导出对话', '归档', '关闭', '删除']) {
      expect(within(menu).getByText(label)).toBeInTheDocument();
    }
    fireEvent.click(within(menu).getByText('导出对话'));
    expect(onExport).toHaveBeenCalledOnce();
  });

  it('下拉中的分屏切换触发 onSplitModeChange', async () => {
    const onSplitModeChange = vi.fn();
    render(<SessionHeader session={baseSession} status="running" onClose={vi.fn()} onDelete={vi.fn()} splitMode="vertical" onSplitModeChange={onSplitModeChange} live onLiveChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId('session-header-overflow'));
    await screen.findByTestId('session-header-overflow-menu');
    fireEvent.click(within(screen.getByTestId('session-header-overflow-menu')).getByText('仅会话'));
    expect(onSplitModeChange).toHaveBeenCalledWith('chat');
  });

  it('已归档会话下拉入口为「取消归档」，归档中禁用', async () => {
    render(<SessionHeader session={{ ...baseSession, archived: true }} status="ended" onClose={vi.fn()} onDelete={vi.fn()} onArchiveToggle={vi.fn()} archiving />);

    fireEvent.click(screen.getByTestId('session-header-overflow'));
    await screen.findByTestId('session-header-overflow-menu');

    const item = within(screen.getByTestId('session-header-overflow-menu')).getByText('归档中...');
    expect(item).toBeInTheDocument();
    expect(item.closest('[data-disabled], [aria-disabled="true"]')).not.toBeNull();
    expect(within(screen.getByTestId('session-header-overflow-menu')).queryByText('取消归档')).toBeNull();
    expect(within(screen.getByTestId('session-header-overflow-menu')).queryByText('归档')).toBeNull();
  });

  it('已归档但非进行中：下拉入口为「取消归档」且可点击', async () => {
    const onArchiveToggle = vi.fn();
    render(<SessionHeader session={{ ...baseSession, archived: true }} status="ended" onClose={vi.fn()} onDelete={vi.fn()} onArchiveToggle={onArchiveToggle} />);

    fireEvent.click(screen.getByTestId('session-header-overflow'));
    await screen.findByTestId('session-header-overflow-menu');
    fireEvent.click(within(screen.getByTestId('session-header-overflow-menu')).getByText('取消归档'));
    expect(onArchiveToggle).toHaveBeenCalledOnce();
  });

  it('下拉中「继续」受能力门控与控制器在线状态禁用', async () => {
    render(
      <SessionHeader
        session={baseSession}
        status="ended"
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onContinue={vi.fn()}
        controllerOnline={false}
      />,
    );

    fireEvent.click(screen.getByTestId('session-header-overflow'));
    await screen.findByTestId('session-header-overflow-menu');

    const item = within(screen.getByTestId('session-header-overflow-menu')).getByText('继续');
    expect(item.closest('[data-disabled], [aria-disabled="true"]')).not.toBeNull();
  });
});
