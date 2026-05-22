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
