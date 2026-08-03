import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import DiffView from '../DiffView';

describe('DiffView', () => {
  it('should render oldText null as new-file full-add mode', () => {
    render(<DiffView oldText={null} newText={'line1\nline2'} filePath="src/new.ts" />);

    expect(screen.getByText('src/new.ts')).toBeDefined();
    expect(screen.getByText('新建文件')).toBeDefined();
    expect(screen.getByText('line1')).toBeDefined();
    expect(screen.getByText('line2')).toBeDefined();
  });

  it('should render modification diff when both texts present', () => {
    render(<DiffView oldText={'old line'} newText={'new line'} filePath="src/a.ts" />);

    expect(screen.getByText('old line')).toBeDefined();
    expect(screen.getByText('new line')).toBeDefined();
  });
});
