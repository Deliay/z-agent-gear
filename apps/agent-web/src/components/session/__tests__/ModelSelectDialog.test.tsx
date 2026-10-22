import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelSelectDialog } from '../ModelSelectDialog';

const defaultModels = [
  { id: 'gpt-4', name: 'GPT-4', provider: 'OpenAI' },
  { id: 'claude-3', name: 'Claude 3', provider: 'Anthropic' },
  { id: 'local-model', name: 'Local Model', provider: null },
];

describe('ModelSelectDialog', () => {
  it('should not render when closed', () => {
    render(
      <ModelSelectDialog
        open={false}
        models={defaultModels}
        currentModelId={null}
        loading={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText('Switch Model')).toBeNull();
  });

  it('should render when open', () => {
    render(
      <ModelSelectDialog
        open={true}
        models={defaultModels}
        currentModelId={null}
        loading={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Switch Model')).toBeDefined();
  });

  it('should display all models', () => {
    render(
      <ModelSelectDialog
        open={true}
        models={defaultModels}
        currentModelId={null}
        loading={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('GPT-4')).toBeDefined();
    expect(screen.getByText('Claude 3')).toBeDefined();
    expect(screen.getByText('Local Model')).toBeDefined();
  });

  it('should display provider names', () => {
    render(
      <ModelSelectDialog
        open={true}
        models={defaultModels}
        currentModelId={null}
        loading={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('OpenAI')).toBeDefined();
    expect(screen.getByText('Anthropic')).toBeDefined();
  });

  it('should mark current model with checkmark icon', () => {
    render(
      <ModelSelectDialog
        open={true}
        models={defaultModels}
        currentModelId="gpt-4"
        loading={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const checkmarks = document.querySelectorAll('svg');
    expect(checkmarks.length).toBeGreaterThan(0);
  });

  it('should call onSelect when model is clicked and confirmed', () => {
    const onSelect = vi.fn();
    render(
      <ModelSelectDialog
        open={true}
        models={defaultModels}
        currentModelId={null}
        loading={false}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('GPT-4'));
    fireEvent.click(screen.getByText('Confirm'));

    expect(onSelect).toHaveBeenCalledWith('gpt-4');
  });

  it('should disable confirm button when loading', () => {
    render(
      <ModelSelectDialog
        open={true}
        models={defaultModels}
        currentModelId={null}
        loading={true}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const confirmButton = screen.getByText('Switching...') as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
  });

  it('should show "Switching..." text when loading', () => {
    render(
      <ModelSelectDialog
        open={true}
        models={defaultModels}
        currentModelId={null}
        loading={true}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Switching...')).toBeDefined();
  });

  it('should call onClose when cancel button is clicked', () => {
    const onClose = vi.fn();
    render(
      <ModelSelectDialog
        open={true}
        models={defaultModels}
        currentModelId={null}
        loading={false}
        onSelect={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('Cancel'));

    expect(onClose).toHaveBeenCalled();
  });
});

describe('ModelSelectDialog - 来源分组', () => {
  const groupedModels = [
    { id: 'gpt-4o', name: 'GPT-4o', provider: null, group: '平台内置', basis: '按平台模型库比对（平台内置）' },
    { id: 'my-model', name: 'My Model', provider: null, group: '自定义', basis: '按平台模型库比对（自定义）' },
    { id: 'opencode-go/kimi', name: 'Kimi', provider: null, group: 'Agent 自带', basis: '按标识前缀判定（opencode-go）' },
    { id: 'local-llm', name: 'Local LLM', provider: null, group: null, basis: null },
  ];

  function renderDialog(models: typeof groupedModels) {
    return render(
      <ModelSelectDialog
        open={true}
        models={models}
        currentModelId={null}
        loading={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
  }

  it('T-W6: 四个来源组头按固定顺序渲染，组内保持输入顺序', () => {
    renderDialog(groupedModels);

    // 直接断言 DOM 中 model-group-* 的顺序（不用 textContent.indexOf：组名与依据文案可能撞名）
    const groupIds = screen
      .getAllByTestId(/^model-group-/)
      .map((element) => element.getAttribute('data-testid'));
    expect(groupIds).toEqual([
      'model-group-平台内置',
      'model-group-Agent 自带',
      'model-group-自定义',
      'model-group-来源未知',
    ]);

    expect(screen.getByTestId('model-group-平台内置').textContent).toContain('GPT-4o');
    expect(screen.getByTestId('model-group-Agent 自带').textContent).toContain('Kimi');
  });

  it('T-W7: group 缺失时归入「来源未知」，不丢模型', () => {
    renderDialog(groupedModels);
    expect(screen.getByTestId('model-group-来源未知').textContent).toContain('Local LLM');
  });

  it('T-W8: 组头展示判定依据（同类去重，多类以「；」连接）', () => {
    renderDialog([
      { id: 'a', name: 'A', provider: null, group: 'Agent 自带', basis: '按标识前缀判定（p1）' },
      { id: 'b', name: 'B', provider: null, group: 'Agent 自带', basis: '按标识前缀判定（p1）' },
      { id: 'c', name: 'C', provider: null, group: 'Agent 自带', basis: '按标识前缀判定（p2）' },
    ]);

    const group = screen.getByTestId('model-group-Agent 自带').textContent ?? '';
    expect(group).toContain('按标识前缀判定（p1）；按标识前缀判定（p2）');
    expect(group.match(/按标识前缀判定（p1）/g)).toHaveLength(1);
  });
});
