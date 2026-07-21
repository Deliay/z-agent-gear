import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ModeSwitcher from '../ModeSwitcher';

const defaultModes = [
  { id: 'code', name: 'Code', description: 'Coding mode' },
  { id: 'ask', name: 'Ask', description: 'Ask questions' },
];

describe('ModeSwitcher', () => {
  it('should display current mode name', () => {
    render(
      <ModeSwitcher
        currentModeId="code"
        modes={defaultModes}
        status="idling"
        onSetMode={vi.fn()}
      />,
    );

    expect(screen.getByText('Code')).toBeDefined();
  });

  it('should display "Mode" placeholder when no current mode', () => {
    render(
      <ModeSwitcher
        currentModeId={null}
        modes={defaultModes}
        status="idling"
        onSetMode={vi.fn()}
      />,
    );

    expect(screen.getByText('Mode')).toBeDefined();
  });

  it('should be disabled when status is not idling', () => {
    render(
      <ModeSwitcher
        currentModeId="code"
        modes={defaultModes}
        status="running"
        onSetMode={vi.fn()}
      />,
    );

    const button = screen.getByRole('button');
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('should be disabled when modes list is empty', () => {
    render(
      <ModeSwitcher
        currentModeId={null}
        modes={[]}
        status="idling"
        onSetMode={vi.fn()}
      />,
    );

    const button = screen.getByRole('button');
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('should be enabled when status is idling and modes exist', () => {
    render(
      <ModeSwitcher
        currentModeId="code"
        modes={defaultModes}
        status="idling"
        onSetMode={vi.fn()}
      />,
    );

    const button = screen.getByRole('button');
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('should open ModeSelectDialog on click', () => {
    render(
      <ModeSwitcher
        currentModeId="code"
        modes={defaultModes}
        status="idling"
        onSetMode={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('切换模式')).toBeDefined();
  });
});
