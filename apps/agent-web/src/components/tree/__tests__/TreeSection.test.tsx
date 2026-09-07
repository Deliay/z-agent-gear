import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TreeSection from '../TreeSection';

describe('TreeSection', () => {
  it('renders title', () => {
    render(
      <TreeSection title="Test Section">
        <div>Child content</div>
      </TreeSection>
    );
    expect(screen.getByText('Test Section')).toBeInTheDocument();
  });

  it('toggles expand/collapse', () => {
    render(
      <TreeSection title="Test Section">
        <div>Child content</div>
      </TreeSection>
    );
    
    // Initially expanded
    expect(screen.getByText('Child content')).toBeInTheDocument();
    
    // Click to collapse
    fireEvent.click(screen.getByText('Test Section'));
    expect(screen.queryByText('Child content')).not.toBeInTheDocument();
    
    // Click to expand again
    fireEvent.click(screen.getByText('Test Section'));
    expect(screen.getByText('Child content')).toBeInTheDocument();
  });

  it('shows count when provided', () => {
    render(
      <TreeSection title="Test Section" count={5}>
        <div>Child content</div>
      </TreeSection>
    );
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('shows empty message when no children and hasContent not provided', () => {
    render(
      <TreeSection title="Test Section" emptyMessage="No items">
        {null}
      </TreeSection>
    );
    expect(screen.getByText('No items')).toBeInTheDocument();
  });

  it('shows empty message when hasContent is false', () => {
    render(
      <TreeSection title="Test Section" emptyMessage="No items" hasContent={false}>
        <div>Child content</div>
      </TreeSection>
    );
    expect(screen.getByText('No items')).toBeInTheDocument();
    // children 仍然挂载但隐藏
    expect(screen.getByText('Child content')).toBeInTheDocument();
  });

  it('shows children when hasContent is true', () => {
    render(
      <TreeSection title="Test Section" hasContent={true}>
        <div>Child content</div>
      </TreeSection>
    );
    expect(screen.getByText('Child content')).toBeInTheDocument();
  });

  it('shows children when hasContent is undefined and children exist', () => {
    render(
      <TreeSection title="Test Section">
        <div>Child content</div>
      </TreeSection>
    );
    expect(screen.getByText('Child content')).toBeInTheDocument();
  });
});