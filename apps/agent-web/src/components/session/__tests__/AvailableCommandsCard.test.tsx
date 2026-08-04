import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AvailableCommandsCard from '../AvailableCommandsCard';

describe('AvailableCommandsCard', () => {
  const data = {
    sessionUpdate: 'available_commands_update',
    availableCommands: [
      { name: 'clear', description: 'Clear session' },
      { name: 'compact', description: 'Compact context' },
    ],
  } as never;

  it('should render command list with count summary', () => {
    render(<AvailableCommandsCard data={data} />);
    expect(screen.getByText('2 个工具已加载')).toBeDefined();
    fireEvent.click(screen.getByText('Tools'));
    expect(screen.getByText('clear')).toBeDefined();
    expect(screen.getByText('compact')).toBeDefined();
  });

  it('should use muted style without in-progress pulse animation', () => {
    const { container } = render(<AvailableCommandsCard data={data} />);
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('bg-muted');
    expect(card.className).not.toContain('animate-pulse');
  });
});
