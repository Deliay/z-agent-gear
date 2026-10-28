import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ToolCallContent } from '@agentclientprotocol/sdk';
import ContentBlockRenderer from '../ContentBlockRenderer';

function renderContent(content: ToolCallContent[]) {
  return render(<ContentBlockRenderer content={content} />);
}

describe('ContentBlockRenderer', () => {
  it('T-CBR1 should render text as markdown', () => {
    renderContent([{ type: 'content', content: { type: 'text', text: '**bold** text' } }]);
    expect(screen.getByText('bold').tagName).toBe('STRONG');
  });

  it('T-CBR2 should render images with data uri', () => {
    renderContent([{ type: 'content', content: { type: 'image', data: 'YWJj', mimeType: 'image/png' } }]);
    const img = screen.getByAltText('工具产出图片') as HTMLImageElement;
    expect(img.src).toBe('data:image/png;base64,YWJj');
  });

  it('T-CBR3 should render audio with controls', () => {
    const { container } = renderContent([
      { type: 'content', content: { type: 'audio', data: 'YWJj', mimeType: 'audio/mpeg' } },
    ]);
    const audio = container.querySelector('audio')!;
    expect(audio).toBeTruthy();
    expect(audio.hasAttribute('controls')).toBe(true);
  });

  it('T-CBR4 should render resource links opening in a new window', () => {
    renderContent([
      { type: 'content', content: { type: 'resource_link', uri: 'https://example.com/doc', name: 'Doc', description: 'desc' } },
    ]);
    const link = screen.getByText('Doc').closest('a')!;
    expect(link.getAttribute('href')).toBe('https://example.com/doc');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
  });

  it('T-CBR5 should render embedded text resources and blob placeholders', () => {
    const text = renderContent([
      {
        type: 'content',
        content: {
          type: 'resource',
          resource: { uri: 'file:///a.md', text: 'embedded text', mimeType: 'text/markdown' },
        },
      },
    ]);
    expect(screen.getByText('embedded text')).toBeDefined();
    text.unmount();

    renderContent([
      {
        type: 'content',
        content: {
          type: 'resource',
          resource: { uri: 'file:///a.bin', blob: 'AAAA', mimeType: 'application/octet-stream' },
        },
      },
    ]);
    expect(screen.getByText(/file:\/\/\/a\.bin/)).toBeDefined();
    expect(screen.getByText(/二进制内容未内嵌/)).toBeDefined();
  });

  it('T-CBR6 should degrade unknown content types without blank output', () => {
    renderContent([
      { type: 'content', content: { type: 'hologram' } } as unknown as ToolCallContent,
    ]);
    expect(screen.getByText(/暂不支持的内容类型：hologram/)).toBeDefined();
  });

  it('should render diff and terminal content types', () => {
    const { container } = renderContent([
      { type: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' },
      { type: 'terminal', terminalId: 'term-1' },
    ]);

    expect(container.querySelector('[data-testid="diff-view"]')).toBeTruthy();
    expect(screen.getByText(/term-1/)).toBeDefined();
  });
});
