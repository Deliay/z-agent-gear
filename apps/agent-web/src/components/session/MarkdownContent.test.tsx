import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import MarkdownContent from './MarkdownContent';

describe('MarkdownContent 窄面板溢出防护', () => {
  it('GFM 表格包裹横向滚动容器，单元格可断词', () => {
    const { container } = render(
      <MarkdownContent content={'| 列A | 列B |\n| --- | --- |\n| 很长的值'.repeat(1) + 'x'.repeat(200) + ' | y |'} />,
    );
    const wrapper = container.querySelector('div.overflow-x-auto');
    expect(wrapper).toBeTruthy();
    expect(wrapper!.querySelector('table')).toBeTruthy();
    const td = container.querySelector('td')!;
    expect(td.className).toContain('break-words');
  });

  it('行内 code 可断行（长路径/URL/token 不撑破容器）', () => {
    const { container } = render(<MarkdownContent content={`see \`${'a'.repeat(200)}\``} />);
    const code = container.querySelector('code')!;
    expect(code.className).toContain('break-all');
  });

  it('链接可断行且新窗口打开', () => {
    const { container } = render(
      <MarkdownContent content={`[link](https://example.com/${'p'.repeat(200)})`} />,
    );
    const a = container.querySelector('a')!;
    expect(a.className).toContain('break-all');
    expect(a.getAttribute('target')).toBe('_blank');
  });
});
