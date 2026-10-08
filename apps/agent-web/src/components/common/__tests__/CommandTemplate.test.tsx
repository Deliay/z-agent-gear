import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import CommandTemplate from '../CommandTemplate';

// Mock clipboard API
const mockWriteText = vi.fn();
Object.assign(navigator, {
  clipboard: {
    writeText: mockWriteText,
  },
});

describe('CommandTemplate', () => {
  const testKey = 'test-controller-key-123';

  it('renders with default command', () => {
    render(<CommandTemplate keyValue={testKey} />);
    expect(screen.getByText(/npx agent-gear --key/)).toBeInTheDocument();
  });

  it('displays correct endpoint for cn region', () => {
    render(<CommandTemplate keyValue={testKey} />);
    expect(screen.getByText(/https:\/\/ctrl\.zag\.fffdan\.com/)).toBeInTheDocument();
  });

  it('shows copy button', () => {
    render(<CommandTemplate keyValue={testKey} />);
    const copyButtons = screen.getAllByRole('button');
    expect(copyButtons.length).toBeGreaterThan(0);
  });
});