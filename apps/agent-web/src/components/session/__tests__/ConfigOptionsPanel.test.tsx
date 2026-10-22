import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ConfigOptionsPanel from '../ConfigOptionsPanel';
import type { SessionConfigOptionData } from '../../../graphql/types';

function renderPanel(configOptions: SessionConfigOptionData[], status = 'idling') {
  const onSetConfigOption = vi.fn().mockResolvedValue(undefined);
  const utils = render(
    <ConfigOptionsPanel
      configOptions={configOptions}
      status={status}
      onSetConfigOption={onSetConfigOption}
    />,
  );
  return { onSetConfigOption, ...utils };
}

const boolOption: SessionConfigOptionData = {
  id: 'auto_save',
  name: 'Auto Save',
  type: 'boolean',
  currentValue: 'false',
};

const selectOption: SessionConfigOptionData = {
  id: 'thought_level',
  name: 'Thought Level',
  type: 'select',
  currentValue: 'low',
  options: [
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' },
  ],
};

describe('ConfigOptionsPanel', () => {
  it('should toggle a boolean option via switch', async () => {
    const { onSetConfigOption } = renderPanel([boolOption]);

    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => expect(onSetConfigOption).toHaveBeenCalledWith('auto_save', 'true'));
  });

  it('should set a select option via dropdown', async () => {
    const { onSetConfigOption } = renderPanel([selectOption]);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'high' } });

    await waitFor(() => expect(onSetConfigOption).toHaveBeenCalledWith('thought_level', 'high'));
  });

  it('should disable controls when session is not idling', () => {
    renderPanel([boolOption, selectOption], 'running');

    expect(screen.getByRole('switch')).toHaveProperty('disabled', true);
    expect(screen.getByRole('combobox')).toHaveProperty('disabled', true);
  });

  it('should render nothing when config options are empty', () => {
    const { container } = renderPanel([]);

    expect(container.firstChild).toBeNull();
  });

  it('should group options by category with group headers', () => {
    renderPanel([
      { ...boolOption, category: 'model_config' },
      { ...selectOption, category: 'thought_level' },
    ]);

    expect(screen.getByText('model_config')).toBeDefined();
    expect(screen.getByText('thought_level')).toBeDefined();
    expect(screen.getByText('Auto Save')).toBeDefined();
    expect(screen.getByText('Thought Level')).toBeDefined();
  });

  it('should group uncategorized options under 其他', () => {
    renderPanel([
      { ...boolOption, category: 'model_config' },
      selectOption,
    ]);

    expect(screen.getByText('其他')).toBeDefined();
  });

  it('should filter out mode and model category options', () => {
    renderPanel([
      { id: 'mode', name: 'Mode', type: 'select', category: 'mode', currentValue: 'code', options: [{ value: 'code' }] },
      { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'm1', options: [{ value: 'm1' }] },
      boolOption,
    ]);

    expect(screen.queryByText('Mode')).toBeNull();
    expect(screen.queryByText('Model')).toBeNull();
    expect(screen.getByText('Auto Save')).toBeDefined();
  });

  it('should render nothing when only mode/model options exist', () => {
    const { container } = renderPanel([
      { id: 'mode', name: 'Mode', type: 'select', category: 'mode', currentValue: 'code', options: [{ value: 'code' }] },
    ]);

    expect(container.firstChild).toBeNull();
  });
});
