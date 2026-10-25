import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HarnessLoginDialog } from '../HarnessLoginDialog';
import {
  openHarnessLoginDialog,
  resetHarnessLoginDialog,
} from '../../../stores/harnessLoginDialog';

const mockRespondHarnessLogin = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useMutation: () => [mockRespondHarnessLogin],
}));

const request = {
  requestId: 'hl-1',
  controllerId: 'ctrl-1',
  serverType: 'kimi_code',
  trigger: 'probe-options',
  url: 'https://www.kimi.com/code/authorize_device?user_code=4CQ4-0XIG',
  userCode: '4CQ4-0XIG',
  expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
};

describe('HarnessLoginDialog（T-W2）', () => {
  beforeEach(() => {
    resetHarnessLoginDialog();
    vi.clearAllMocks();
    mockRespondHarnessLogin.mockResolvedValue({ data: { respondHarnessLogin: true } });
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('逐字展示登录链接与验证码', () => {
    openHarnessLoginDialog(request);
    render(<HarnessLoginDialog />);

    expect(screen.getByTestId('harness-login-url')).toHaveTextContent(request.url);
    expect(screen.getByTestId('harness-login-code')).toHaveTextContent(request.userCode);
  });

  it('复制链接与验证码调用剪贴板', async () => {
    openHarnessLoginDialog(request);
    render(<HarnessLoginDialog />);

    fireEvent.click(screen.getByRole('button', { name: '复制链接' }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(request.url),
    );

    fireEvent.click(screen.getByRole('button', { name: '复制验证码' }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(request.userCode),
    );
  });

  it('打开登录链接为新标签且带 noreferrer', () => {
    openHarnessLoginDialog(request);
    render(<HarnessLoginDialog />);

    const link = screen.getByRole('link', { name: '打开登录链接' });
    expect(link).toHaveAttribute('href', request.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('取消调用 respondHarnessLogin(cancel) 并关闭弹窗', async () => {
    openHarnessLoginDialog(request);
    render(<HarnessLoginDialog />);

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() =>
      expect(mockRespondHarnessLogin).toHaveBeenCalledWith({
        variables: { requestId: 'hl-1', action: 'cancel' },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('harness-login-url')).toBeNull());
  });

  it('倒计时展示剩余时间', () => {
    openHarnessLoginDialog(request);
    render(<HarnessLoginDialog />);

    expect(screen.getByRole('status')).toHaveTextContent(/等待授权完成/);
    expect(screen.getByRole('status')).toHaveTextContent(/\d+:\d{2}/);
  });

  it('expiresAt 已过展示可重试并隐藏操作按钮', () => {
    openHarnessLoginDialog({ ...request, expiresAt: new Date(Date.now() - 1000).toISOString() });
    render(<HarnessLoginDialog />);

    expect(screen.getByRole('status')).toHaveTextContent('登录未完成，可重试');
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
    expect(screen.queryByRole('link', { name: '打开登录链接' })).toBeNull();
  });

  it('AI 关闭 store（resolved）后自动卸载弹窗', async () => {
    openHarnessLoginDialog(request);
    render(<HarnessLoginDialog />);
    expect(screen.getByTestId('harness-login-url')).toBeInTheDocument();

    const { resolveHarnessLoginDialog } = await import('../../../stores/harnessLoginDialog');
    resolveHarnessLoginDialog('hl-1');

    await waitFor(() => expect(screen.queryByTestId('harness-login-url')).toBeNull());
    expect(mockRespondHarnessLogin).not.toHaveBeenCalled();
  });
});
