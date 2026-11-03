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

  it('T-UI4-TREE1 空态收敛：无子内容时不渲染占位文字（emptyMessage 不再生效）', () => {
    render(
      <TreeSection title="Test Section" emptyMessage="No items">
        {null}
      </TreeSection>
    );
    expect(screen.queryByText('No items')).not.toBeInTheDocument();
    expect(screen.getByText('Test Section')).toBeInTheDocument();
  });

  it('T-UI4-TREE1 hasContent=false 时不渲染占位文字，children 仍挂载但隐藏', () => {
    render(
      <TreeSection title="Test Section" emptyMessage="No items" hasContent={false}>
        <div>Child content</div>
      </TreeSection>
    );
    expect(screen.queryByText('No items')).not.toBeInTheDocument();
    // children 仍然挂载但隐藏
    expect(screen.getByText('Child content')).toBeInTheDocument();
  });

  it('T-UI4-TREE2 标题行全宽（flex-1）且层级缩进按 0.5rem/级', () => {
    const { container, rerender } = render(
      <TreeSection title="Test Section" level={2}>
        <div>Child content</div>
      </TreeSection>
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.paddingLeft).toBe('1rem');
    expect(root).toHaveAttribute('data-tree-level', '2');
    expect(screen.getByRole('button', { name: /Test Section/ }).className).toContain('flex-1');

    rerender(
      <TreeSection title="Test Section" level={0}>
        <div>Child content</div>
      </TreeSection>
    );
    expect((container.firstElementChild as HTMLElement).style.paddingLeft).toBe('0rem');
  });

  it('T-UI4-TREE3 actions（设置按钮）保留并渲染在标题行右侧', () => {
    render(
      <TreeSection
        title="Test Section"
        actions={<button type="button" aria-label="控制器配置">设置</button>}
      >
        <div>Child content</div>
      </TreeSection>
    );
    expect(screen.getByLabelText('控制器配置')).toBeInTheDocument();
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