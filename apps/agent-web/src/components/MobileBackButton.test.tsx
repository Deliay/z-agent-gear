import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MobileBackButton from './MobileBackButton';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('MobileBackButton', () => {
  it('should render back button with default label', () => {
    renderWithRouter(<MobileBackButton />);
    expect(screen.getByText('← 返回')).toBeDefined();
  });

  it('should navigate to specified route on click', () => {
    renderWithRouter(<MobileBackButton to="/sessions" />);
    fireEvent.click(screen.getByRole('button'));
    expect(mockNavigate).toHaveBeenCalledWith('/sessions');
  });

  it('should navigate back when no to prop', () => {
    renderWithRouter(<MobileBackButton />);
    fireEvent.click(screen.getByRole('button'));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it('should have md:hidden class', () => {
    renderWithRouter(<MobileBackButton />);
    const button = screen.getByRole('button');
    expect(button.className).toContain('md:hidden');
  });
});
