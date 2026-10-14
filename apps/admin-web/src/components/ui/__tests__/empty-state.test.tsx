import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Inbox } from 'lucide-react';
import { EmptyState } from '../empty-state';

describe('EmptyState', () => {
  it('renders title', () => {
    render(<EmptyState icon={Inbox} title="No items" />);
    expect(screen.getByText('No items')).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(
      <EmptyState icon={Inbox} title="No items" description="Create one to get started" />
    );
    expect(screen.getByText('Create one to get started')).toBeInTheDocument();
  });

  it('does not render description when omitted', () => {
    const { container } = render(<EmptyState icon={Inbox} title="No items" />);
    expect(container.querySelectorAll('p')).toHaveLength(1);
  });

  it('renders action when provided', () => {
    render(
      <EmptyState icon={Inbox} title="No items" action={<button>Create</button>} />
    );
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });

  it('does not render action when omitted', () => {
    const { container } = render(<EmptyState icon={Inbox} title="No items" />);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});
