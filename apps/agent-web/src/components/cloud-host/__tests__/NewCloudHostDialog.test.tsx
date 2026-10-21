import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NewCloudHostDialog from '../NewCloudHostDialog';
import type { CloudHostCapabilitiesData, HarnessType } from '../../../graphql/types';

const mockCreateCloudHost = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useMutation: () => [mockCreateCloudHost],
}));

const defaultCapabilities: CloudHostCapabilitiesData = {
  enabled: true,
  supportedHarnesses: ['OPENCODE'],
};

const defaultProps = {
  open: true,
  capabilities: defaultCapabilities,
  onClose: vi.fn(),
  onCreated: vi.fn(),
};

function submitButton() {
  return screen.getByRole('button', { name: '创建云电脑' });
}

describe('NewCloudHostDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateCloudHost.mockResolvedValue({
      data: {
        createCloudHost: {
          id: 'cloud-1',
          name: '云电脑 A',
          controllerId: 'ctrl-cloud',
          status: 'STARTING',
          harnessTypes: ['OPENCODE'],
          defaultSessionId: null,
          activeSessionCount: 0,
          failureReason: null,
          deletedAt: null,
        },
      },
    });
  });

  it('T-AW3 名称为空时禁用提交并提示', () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    expect(screen.getByText('请输入云电脑名称')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it('T-AW3 名称全空白视为空', () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '   ' } });

    expect(screen.getByText('请输入云电脑名称')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it('T-AW3 未选择 Harness 时禁用提交', () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });

    expect(screen.getByText('请至少选择一种 Harness')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it('选择 1 个 Harness 时提示将自动创建会话并可提交', () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '  云电脑 A  ' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));

    expect(screen.getByText('将自动创建会话')).toBeInTheDocument();
    expect(submitButton()).not.toBeDisabled();
  });

  it('T-AW4 提交成功使用 trim 后名称与 harnessTypes，并回调创建结果', async () => {
    const onCreated = vi.fn();
    render(<NewCloudHostDialog {...defaultProps} onCreated={onCreated} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '  云电脑 A  ' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(mockCreateCloudHost).toHaveBeenCalledWith({
        variables: { input: { name: '云电脑 A', harnessTypes: ['OPENCODE'] } },
      });
    });
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'cloud-1' }));
    });
  });

  it('多选 Harness 时提示不自动创建会话', () => {
    render(
      <NewCloudHostDialog
        {...defaultProps}
        capabilities={{ enabled: true, supportedHarnesses: ['OPENCODE', 'CLAUDE_CODE'] as HarnessType[] }}
      />,
    );

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    fireEvent.click(screen.getByLabelText('CLAUDE_CODE'));

    expect(screen.getByText('不自动创建会话')).toBeInTheDocument();
  });

  it('T-AW3 名称超过 64 字符时禁用提交并提示', () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'a'.repeat(65) } });

    expect(screen.getByText('名称不能超过 64 个字符')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it('T-AW5 服务端错误文案原样展示', async () => {
    mockCreateCloudHost.mockRejectedValueOnce(new Error('too many cloud hosts'));

    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    fireEvent.click(submitButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('too many cloud hosts');
  });

  it.each([
    'name is required',
    'name is too long',
    'harness feature is disabled',
    'at least one harness type is required',
    'unsupported harness type: x',
  ])('T-AW5 服务端错误「%s」原样展示', async (message) => {
    mockCreateCloudHost.mockRejectedValueOnce(new Error(message));

    render(<NewCloudHostDialog {...defaultProps} />);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '云电脑 A' } });
    fireEvent.click(screen.getByLabelText('OpenCode'));
    fireEvent.click(submitButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('实例上限时禁用提交并提示', () => {
    render(<NewCloudHostDialog {...defaultProps} hasActiveCloudHost />);

    expect(screen.getByText('每用户同时最多 1 个云电脑实例')).toBeInTheDocument();
    expect(submitButton()).toBeDisabled();
  });

  it('T-AW13 不出现存储/会话导入参数', () => {
    render(<NewCloudHostDialog {...defaultProps} />);

    expect(screen.queryByText(/存储会话/)).not.toBeInTheDocument();
    expect(screen.queryByText(/恢复的会话/)).not.toBeInTheDocument();
  });
});
