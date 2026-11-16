import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CreateKnowledgeBaseDialog from '../CreateKnowledgeBaseDialog';

const mockUseMutation = vi.fn();
const mockMutate = vi.fn();
const mockToastSuccess = vi.fn();

vi.mock('@apollo/client/react', () => ({
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
}));

vi.mock('sonner', () => ({
  toast: { success: (...args: unknown[]) => mockToastSuccess(...args), error: vi.fn() },
}));

function renderDialog(callbacks: { onClose?: () => void; onCreated?: (kb: unknown) => void } = {}) {
  return render(
    <CreateKnowledgeBaseDialog
      open
      onClose={callbacks.onClose ?? (() => {})}
      onCreated={callbacks.onCreated}
    />,
  );
}

describe('CreateKnowledgeBaseDialog（T-KBW5）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMutation.mockReturnValue([mockMutate, { loading: false }]);
    mockMutate.mockResolvedValue({
      data: {
        createKnowledgeBase: {
          id: 'kb-new',
          name: '团队规范',
          permissionMode: 'NONE',
          global: false,
          myAccess: {
            canRead: true,
            canCreate: true,
            canUpdate: true,
            canDelete: true,
            canManage: true,
          },
          createdAt: '',
          updatedAt: '',
        },
      },
    });
  });

  it('名称为空时禁用创建；输入后提交 mutation 并回调', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    renderDialog({ onCreated, onClose });

    const submit = screen.getByRole('button', { name: '创建' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('知识库名称'), { target: { value: '  团队规范  ' } });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: { name: '团队规范' },
          refetchQueries: expect.any(Array),
        }),
      );
    });
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'kb-new' }));
      expect(onClose).toHaveBeenCalled();
      expect(mockToastSuccess).toHaveBeenCalledWith('知识库已创建');
    });
  });

  it('服务端重名错误映射为中文且对话框保持打开', async () => {
    const onClose = vi.fn();
    mockMutate.mockRejectedValue(new Error('knowledge base name already exists'));
    renderDialog({ onClose });

    fireEvent.change(screen.getByLabelText('知识库名称'), { target: { value: '重复' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    expect(await screen.findByTestId('knowledge-base-create-error')).toHaveTextContent(
      '当前工作区已存在同名知识库',
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
