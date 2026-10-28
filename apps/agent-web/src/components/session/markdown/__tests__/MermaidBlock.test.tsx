import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MermaidBlock from '../MermaidBlock';

const renderMock = vi.fn();
const initializeMock = vi.fn();

vi.mock('mermaid', () => ({
  default: {
    initialize: (...args: unknown[]) => initializeMock(...args),
    render: (...args: unknown[]) => renderMock(...args),
  },
}));

describe('MermaidBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.classList.remove('dark');
    renderMock.mockResolvedValue({ svg: '<svg data-testid="mermaid-svg"><g></g></svg>' });
  });

  it('T-MM1 should render mermaid output as SVG', async () => {
    const { container } = render(<MermaidBlock code="graph TD; A-->B;" />);

    await waitFor(() => {
      expect(container.querySelector('svg')).toBeTruthy();
    });
    expect(initializeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
      }),
    );
  });

  it('T-MM2 should fall back to a code block on syntax errors', async () => {
    renderMock.mockRejectedValue(new Error('parse error'));
    render(<MermaidBlock code="not a diagram" />);

    await waitFor(() => {
      expect(screen.getByTestId('code-block')).toBeDefined();
    });
    expect(screen.getByText('not a diagram')).toBeDefined();
    expect(screen.getByTestId('code-block-language').textContent).toBe('mermaid');
  });

  it('T-MM3 should zoom in, zoom out and reset within 0.5-3', async () => {
    render(<MermaidBlock code="graph TD; A-->B;" />);
    await waitFor(() => expect(screen.getByTestId('mermaid-zoom-value').textContent).toBe('100%'));

    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    expect(screen.getByTestId('mermaid-zoom-value').textContent).toBe('125%');

    fireEvent.click(screen.getByRole('button', { name: '缩小' }));
    expect(screen.getByTestId('mermaid-zoom-value').textContent).toBe('100%');

    fireEvent.click(screen.getByRole('button', { name: '重置缩放' }));
    expect(screen.getByTestId('mermaid-zoom-value').textContent).toBe('100%');
  });

  it('T-MM4 should toggle between diagram and source', async () => {
    render(<MermaidBlock code="graph TD; A-->B;" />);
    await waitFor(() => expect(screen.getByTestId('mermaid-block')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: '查看源码' }));
    expect(screen.getByText('graph TD; A-->B;')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '查看图形' }));
    expect(screen.queryByText('graph TD; A-->B;')).toBeNull();
  });

  it('T-MM5 should use dark theme when document has dark class', async () => {
    document.documentElement.classList.add('dark');
    render(<MermaidBlock code="graph TD; A-->B;" />);

    await waitFor(() => {
      expect(initializeMock).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }));
    });
  });

  it('T-MM6 should show a skeleton while loading', () => {
    renderMock.mockReturnValue(new Promise(() => {}));
    render(<MermaidBlock code="graph TD; A-->B;" />);

    expect(screen.getByTestId('mermaid-skeleton')).toBeDefined();
  });

  it('T-MM7 should clean up mermaid error elements left on document.body (R-8)', async () => {
    renderMock.mockImplementation(async (id: string) => {
      const temp = document.createElement('div');
      temp.id = `d${id}`;
      document.body.appendChild(temp);
      throw new Error('parse error');
    });

    render(<MermaidBlock code="not a diagram" />);

    await waitFor(() => expect(screen.getByTestId('code-block')).toBeDefined());
    const renderId = renderMock.mock.calls[0][0] as string;
    expect(document.getElementById(`d${renderId}`)).toBeNull();
  });

  it('T-MM8 should copy the source from the source view (M-7)', async () => {
    const code = 'graph TD; A-->B;';
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(<MermaidBlock code={code} />);
    await waitFor(() => expect(screen.getByTestId('mermaid-block')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: '查看源码' }));
    fireEvent.click(screen.getByRole('button', { name: '复制源码' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(code));
  });
});
