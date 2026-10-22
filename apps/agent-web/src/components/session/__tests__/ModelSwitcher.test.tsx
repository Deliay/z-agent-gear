import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelSwitcher } from '../ModelSwitcher';

const defaultModels = [
  { id: 'gpt-4', name: 'GPT-4', provider: 'OpenAI' },
  { id: 'claude-3', name: 'Claude 3', provider: 'Anthropic' },
];

describe('ModelSwitcher', () => {
  it('should display current model name', () => {
    render(
      <ModelSwitcher
        currentModelId="gpt-4"
        availableModels={defaultModels}
        status="idling"
        onSetModel={vi.fn()}
      />,
    );

    expect(screen.getByText('GPT-4')).toBeDefined();
  });

  it('should display "Model" placeholder when no current model', () => {
    render(
      <ModelSwitcher
        currentModelId={null}
        availableModels={defaultModels}
        status="idling"
        onSetModel={vi.fn()}
      />,
    );

    expect(screen.getByText('Model')).toBeDefined();
  });

  it('should be disabled when status is not idling', () => {
    render(
      <ModelSwitcher
        currentModelId="gpt-4"
        availableModels={defaultModels}
        status="running"
        onSetModel={vi.fn()}
      />,
    );

    const button = screen.getByRole('button');
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('should be disabled when availableModels list is empty', () => {
    render(
      <ModelSwitcher
        currentModelId={null}
        availableModels={[]}
        status="idling"
        onSetModel={vi.fn()}
      />,
    );

    const button = screen.getByRole('button');
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('should be enabled when status is idling and models exist', () => {
    render(
      <ModelSwitcher
        currentModelId="gpt-4"
        availableModels={defaultModels}
        status="idling"
        onSetModel={vi.fn()}
      />,
    );

    const button = screen.getByRole('button');
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('should open ModelSelectDialog on click', () => {
    render(
      <ModelSwitcher
        currentModelId="gpt-4"
        availableModels={defaultModels}
        status="idling"
        onSetModel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Switch Model')).toBeDefined();
  });
});
