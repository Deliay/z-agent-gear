import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AcpCard from '../AcpCard';

describe('AcpCard', () => {
  it('should render title and summary', () => {
    render(
      <AcpCard title="Tool Call" summary="Edit done">
        <div>content</div>
      </AcpCard>,
    );
    expect(screen.getByText('Tool Call')).toBeDefined();
    expect(screen.getByText('Edit done')).toBeDefined();
  });

  it('should render children when expanded', () => {
    render(
      <AcpCard title="Tool Call" summary="Edit done" expanded>
        <div>body content</div>
      </AcpCard>,
    );
    expect(screen.getByText('body content')).toBeDefined();
  });

  it('should hide children when collapsed', () => {
    render(
      <AcpCard title="Tool Call" summary="Edit done" defaultCollapsed>
        <div>body content</div>
      </AcpCard>,
    );
    expect(screen.queryByText('body content')).toBeNull();
  });

  it('should expand/collapse on header click', () => {
    render(
      <AcpCard title="Tool Call" summary="Edit done" defaultCollapsed>
        <div>body content</div>
      </AcpCard>,
    );
    expect(screen.queryByText('body content')).toBeNull();
    fireEvent.click(screen.getByText('Tool Call'));
    expect(screen.getByText('body content')).toBeDefined();
  });

  it('should apply info emphasis and pulse classes for purple color', () => {
    const { container } = render(
      <AcpCard title="Tool Call" summary="..." color="purple">
        <div>content</div>
      </AcpCard>,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('bg-info/10');
    expect(card.className).toContain('border-info');
    expect(card.className).toContain('motion-safe:animate-pulse');
    const header = screen.getByText('Tool Call').closest('button') as HTMLElement;
    expect(header.className).toContain('text-info');
  });

  it('should keep muted style for blue, gray and yellow colors', () => {
    for (const color of ['blue', 'gray', 'yellow'] as const) {
      const { container, unmount } = render(
        <AcpCard title="Tool Call" summary="..." color={color}>
          <div>content</div>
        </AcpCard>,
      );
      const card = container.firstElementChild as HTMLElement;
      expect(card.className).toContain('bg-muted');
      expect(card.className).toContain('border-border');
      expect(card.className).not.toContain('animate-pulse');
      unmount();
    }
  });

  it('should apply strongest info highlight and pulse for active color', () => {
    const { container } = render(
      <AcpCard title="Tool Call" summary="..." color="active">
        <div>content</div>
      </AcpCard>,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('bg-info/10');
    expect(card.className).toContain('border-info');
    expect(card.className).toContain('motion-safe:animate-pulse');
  });

  it('should apply softer same-family highlight without pulse for completed color', () => {
    const { container } = render(
      <AcpCard title="Tool Call" summary="✓" color="completed">
        <div>content</div>
      </AcpCard>,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('bg-info/5');
    expect(card.className).toContain('border-info/40');
    expect(card.className).not.toContain('animate-pulse');
    const header = screen.getByText('Tool Call').closest('button') as HTMLElement;
    expect(header.className).toContain('text-info');
  });

  it('should apply same-family highlight with destructive summary for failed color', () => {
    const { container } = render(
      <AcpCard title="Tool Call" summary="✗" color="failed">
        <div>content</div>
      </AcpCard>,
    );
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain('bg-info/5');
    expect(card.className).toContain('border-info/40');
    expect(card.className).not.toContain('animate-pulse');
    const summary = screen.getByText('✗');
    expect(summary.className).toContain('text-destructive');
  });
});
