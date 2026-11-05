// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, cleanup, act } from '@testing-library/react';
import { HtmlPreview } from '../HtmlPreview';
import { AnnotationPopup } from '../AnnotationPopup';
import { AnnotationList } from '../AnnotationList';
import type { ReviewComment } from '../../../../lib/preview/types';

afterEach(() => cleanup());

describe('AnnotationPopup / AnnotationList（T-ANNP1~2）', () => {
  it('T-ANNP1 弹层确认/取消', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<AnnotationPopup anchorLabel="L12" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.change(screen.getByTestId('annotation-input'), { target: { value: '  fix it  ' } });
    fireEvent.click(screen.getByTestId('annotation-confirm'));
    expect(onConfirm).toHaveBeenCalledWith('fix it');
    fireEvent.click(screen.getByTestId('annotation-cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('T-ANNP2 列表删除', () => {
    const comments: ReviewComment[] = [
      { id: 'c1', anchor: { kind: 'html', selector: '#a', innerHtml: '' }, body: 'b1', createdAt: '' },
    ];
    const onRemove = vi.fn();
    render(<AnnotationList comments={comments} onRemove={onRemove} />);
    fireEvent.click(screen.getAllByTestId('annotation-remove')[0]);
    expect(onRemove).toHaveBeenCalledWith('c1');
  });
});

describe('HtmlPreview（T-HTML1~6）', () => {
  const html = '<html><body><button id="go">Go</button></body></html>';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('T-HTML1 postMessage 校验：错令牌 / 错 source 拒绝', () => {
    // 捕获组件注册的 message 监听器，直接注入事件对象（jsdom MessageEvent.source 不可靠）
    const handlers: Array<(event: MessageEvent) => void> = [];
    vi.spyOn(window, 'addEventListener').mockImplementation((type: string, handler: EventListenerOrEventListenerObject) => {
      if (type === 'message') handlers.push(handler as (event: MessageEvent) => void);
    });

    render(<HtmlPreview html={html} onConfirm={vi.fn()} />);
    fireEvent.click(screen.getByTestId('html-annotate-toggle'));
    const frame = screen.getByTestId('html-preview-frame') as HTMLIFrameElement;

    // 伪造 iframe.contentWindow（jsdom 不加载 srcdoc 文档）
    const fakeWindow = {} as Window;
    Object.defineProperty(frame, 'contentWindow', { value: fakeWindow });

    const srcDoc = frame.getAttribute('srcdoc') ?? '';
    const token = /var TOKEN = "([^"]+)"/.exec(srcDoc)?.[1] ?? '';
    expect(token).not.toBe('');
    expect(handlers.length).toBeGreaterThan(0);
    const onMessage = handlers[handlers.length - 1];

    const select = (source: unknown, tok: string, selector: string, selected = true) =>
      act(() => {
        onMessage({
          source,
          data: { zagPreview: true, token: tok, type: 'select', payload: { selector, innerHtml: 'Go', selected } },
        } as MessageEvent);
      });

    // 错 source / 错令牌：均拒绝
    select(window, token, '#bad-source');
    select(fakeWindow, 'wrong-token', '#bad-token');
    expect(screen.queryByTestId('html-annotate-selected')).toBeNull();

    // 正确令牌 + 正确 source：进入已选集合
    select(fakeWindow, token, '#go');
    expect(screen.getByTestId('html-annotate-selected').textContent).toContain('已选 1');

    // T-HTML2 再点已选元素取消（selected=false）
    select(fakeWindow, token, '#go', false);
    expect(screen.queryByTestId('html-annotate-selected')).toBeNull();
  });

  it('T-HTML3 innerHtml 截断（脚本侧 ≤4000）', () => {
    render(<HtmlPreview html={html} onConfirm={vi.fn()} />);
    fireEvent.click(screen.getByTestId('html-annotate-toggle'));
    const frame = screen.getByTestId('html-preview-frame') as HTMLIFrameElement;
    const srcDoc = frame.getAttribute('srcdoc') ?? '';
    expect(srcDoc).toContain('innerHtml.length > 4000');
  });

  it('T-HTML4 srcDoc 变更重建 iframe（key 变化）', () => {
    const { rerender } = render(<HtmlPreview html={html} onConfirm={vi.fn()} />);
    const first = screen.getByTestId('html-preview-frame');
    rerender(<HtmlPreview html="<html><body><p>new</p></body></html>" onConfirm={vi.fn()} />);
    const second = screen.getByTestId('html-preview-frame');
    expect(second).not.toBe(first);
  });

  it('T-HTML5 批注回传 AnnotationBatch{source:html}；空批注禁用确认', () => {
    const onConfirm = vi.fn();
    render(<HtmlPreview html={html} filePath="a.html" onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId('html-annotate-toggle'));
    // 空批注列表时「确认回传」禁用
    expect((screen.getByTestId('html-confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('T-HTML6 sandbox 属性无 allow-same-origin', () => {
    render(<HtmlPreview html={html} onConfirm={vi.fn()} />);
    const frame = screen.getByTestId('html-preview-frame');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  });
});
