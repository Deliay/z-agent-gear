import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button, buttonVariants } from '../button';

describe('Button', () => {
  it('renders with default variant', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: 'Click me' })).toBeInTheDocument();
  });

  it('renders with ghost-danger variant', () => {
    render(<Button variant="ghost-danger">Delete</Button>);
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect(btn).toBeInTheDocument();
    expect(btn.className).toContain('text-destructive');
  });

  it('renders with xs size', () => {
    render(<Button size="xs">Small</Button>);
    const btn = screen.getByRole('button', { name: 'Small' });
    expect(btn).toBeInTheDocument();
    expect(btn.className).toContain('h-6');
  });

  it('applies custom className', () => {
    render(<Button className="custom-class">Test</Button>);
    expect(screen.getByRole('button')).toHaveClass('custom-class');
  });

  it('is disabled when disabled prop is set', () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});

describe('buttonVariants', () => {
  it('returns correct classes for default variant', () => {
    const classes = buttonVariants({ variant: 'default', size: 'default' });
    expect(classes).toContain('bg-primary');
    expect(classes).toContain('text-primary-foreground');
  });

  it('returns correct classes for ghost-danger variant', () => {
    const classes = buttonVariants({ variant: 'ghost-danger' });
    expect(classes).toContain('text-destructive');
  });

  it('returns correct classes for xs size', () => {
    const classes = buttonVariants({ size: 'xs' });
    expect(classes).toContain('h-6');
    expect(classes).toContain('text-xs');
  });
});
