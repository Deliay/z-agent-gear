import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ModeSelectDialog from '../ModeSelectDialog';

const defaultModes = [
  { id: 'code', name: 'Code', description: 'Coding mode' },
  { id: 'ask', name: 'Ask', description: 'Ask questions' },
  { id: 'architect', name: 'Architect', description: null },
];

describe('ModeSelectDialog', () => {
  it('should not render when closed', () => {
    render(
      <ModeSelectDialog
        open={false}
        modes={defaultModes}
        currentModeId={null}
        loading={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText('Switch Mode')).toBeNull();
  });

  it('should render when open', () => {
    render(
      <ModeSelectDialog
        open={true}
        modes={defaultModes}
        currentModeId={null}
        loading={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Switch Mode')).toBeDefined();
  });

  it('should display all modes', () => {
    render(
      <ModeSelectDialog
        open={true}
        modes={defaultModes}
        currentModeId={null}
        loading={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Code')).toBeDefined();
    expect(screen.getByText('Ask')).toBeDefined();
    expect(screen.getByText('Architect')).toBeDefined();
  });

  it('should display mode descriptions', () => {
    render(
      <ModeSelectDialog
        open={true}
        modes={defaultModes}
        currentModeId={null}
        loading={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Coding mode')).toBeDefined();
    expect(screen.getByText('Ask questions')).toBeDefined();
  });

  it('should mark current mode with checkmark', () => {
    render(
      <ModeSelectDialog
        open={true}
        modes={defaultModes}
        currentModeId="code"
        loading={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('✓')).toBeDefined();
  });

  it('should call onSelect when confirm button is clicked', () => {
    const onSelect = vi.fn();
    render(
      <ModeSelectDialog
        open={true}
        modes={defaultModes}
        currentModeId={null}
        loading={false}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('Code'));
    fireEvent.click(screen.getByText('Confirm'));

    expect(onSelect).toHaveBeenCalledWith('code');
  });

  it('should disable confirm button when no mode selected', () => {
    render(
      <ModeSelectDialog
        open={true}
        modes={defaultModes}
        currentModeId={null}
        loading={false}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const confirmButton = screen.getByText('Confirm') as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
  });

  it('should show "Switching..." text when loading', () => {
    render(
      <ModeSelectDialog
        open={true}
        modes={defaultModes}
        currentModeId={null}
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
      <ModeSelectDialog
        open={true}
        modes={defaultModes}
        currentModeId={null}
        loading={false}
        onSelect={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('Cancel'));

    expect(onClose).toHaveBeenCalled();
  });

});
