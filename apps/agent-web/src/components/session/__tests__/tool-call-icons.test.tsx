import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ToolKindIcon from '../tool-call-icons';

function iconClass(kind?: string): string {
  const { container } = render(<ToolKindIcon kind={kind} />);
  return container.querySelector('svg')?.getAttribute('class') ?? '';
}

describe('ToolKindIcon (M-14)', () => {
  it('should map every known tool kind to its own icon', () => {
    expect(iconClass('read')).toContain('lucide-file-search');
    expect(iconClass('edit')).toContain('lucide-file-pen');
    expect(iconClass('delete')).toContain('lucide-trash-2');
    expect(iconClass('move')).toContain('lucide-arrow-right-left');
    expect(iconClass('search')).toContain('lucide-search');
    expect(iconClass('execute')).toContain('lucide-square-terminal');
    expect(iconClass('think')).toContain('lucide-brain');
    expect(iconClass('fetch')).toContain('lucide-globe');
    expect(iconClass('switch_mode')).toContain('lucide-arrow-right-left');
  });

  it('should fall back to Hammer for unknown and missing kinds', () => {
    expect(iconClass('other')).toContain('lucide-hammer');
    expect(iconClass('brand_new_kind')).toContain('lucide-hammer');
    expect(iconClass(undefined)).toContain('lucide-hammer');
  });

  it('should not use the fallback icon for a known kind', () => {
    expect(iconClass('read')).not.toContain('lucide-hammer');
  });
});
