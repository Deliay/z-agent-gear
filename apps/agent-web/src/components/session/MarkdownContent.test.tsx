import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import MarkdownContent from './MarkdownContent';

const renderMock = vi.fn();

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: (...args: unknown[]) => renderMock(...args),
  },
}));

describe('MarkdownContent 窄面板溢出防护', () => {
  beforeEach(() => {
    renderMock.mockResolvedValue({ svg: '<svg data-testid="mermaid-svg"></svg>' });
  });

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
    // 行内代码不属于代码块工具栏
    expect(container.querySelector('[data-testid="code-block"]')).toBeNull();
  });

  it('链接可断行且新窗口打开', () => {
    const { container } = render(
      <MarkdownContent content={`[link](https://example.com/${'p'.repeat(200)})`} />,
    );
    const a = container.querySelector('a')!;
    expect(a.className).toContain('break-all');
    expect(a.getAttribute('target')).toBe('_blank');
  });

  it('带语言围栏代码块渲染 CodeBlock 工具栏与语言标签', () => {
    render(<MarkdownContent content={'```typescript\nconst a = 1;\n```'} />);

    expect(screen.getByTestId('code-block')).toBeDefined();
    expect(screen.getByTestId('code-block-language').textContent).toBe('typescript');
    expect(screen.getByRole('button', { name: '复制代码' })).toBeDefined();
  });

  it('无语言围栏代码块同样有工具栏，语言显示 text', () => {
    render(<MarkdownContent content={'```\nplain code\n```'} />);

    expect(screen.getByTestId('code-block')).toBeDefined();
    expect(screen.getByTestId('code-block-language').textContent).toBe('text');
    expect(screen.getByRole('button', { name: '复制代码' })).toBeDefined();
  });

  it('mermaid 围栏代码块分流到 MermaidBlock', async () => {
    render(<MarkdownContent content={'```mermaid\ngraph TD; A-->B;\n```'} />);

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-block').querySelector('svg')).toBeTruthy();
    });
    expect(screen.queryByTestId('code-block')).toBeNull();
  });

  it('mermaid 语言名大小写不敏感 (M-4)', async () => {
    render(<MarkdownContent content={'```Mermaid\ngraph TD; A-->B;\n```'} />);

    await waitFor(() => {
      expect(screen.getByTestId('mermaid-block')).toBeDefined();
    });
    expect(screen.queryByTestId('code-block')).toBeNull();
  });

  it('c++ 语言名不被正则截断 (M-4)', () => {
    render(<MarkdownContent content={'```c++\nint main();\n```'} />);

    expect(screen.getByTestId('code-block-language').textContent).toBe('c++');
  });
});
