// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { computeSelector } from '../html-selector.js';
import { injectSelectionScript, buildSelectionScript } from '../html-inject.js';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

describe('computeSelector（T-SEL1~6）', () => {
  it('T-SEL1 id 优先：返回 #id 且可 querySelector 复现', () => {
    const root = mount('<div id="main"><span id="target">x</span></div>');
    const target = root.querySelector('#target')!;
    const selector = computeSelector(target);
    expect(selector).toBe('#target');
    expect(document.querySelector(selector)).toBe(target);
  });

  it('T-SEL2 data-testid 次优', () => {
    const root = mount('<div><button data-testid="submit-btn">ok</button></div>');
    const target = root.querySelector('button')!;
    expect(computeSelector(target)).toBe('[data-testid="submit-btn"]');
    expect(document.querySelector(computeSelector(target))).toBe(target);
  });

  it('T-SEL3 tag:nth-of-type(n) 深层链', () => {
    const root = mount('<div><ul><li>a</li><li>b</li><li>c</li></ul></div>');
    const target = root.querySelectorAll('li')[1];
    const selector = computeSelector(target);
    expect(selector).toBe('div > ul > li:nth-of-type(2)');
    expect(document.querySelector(selector)).toBe(target);
  });

  it('T-SEL4 body 终止：链不包含 body', () => {
    const root = mount('<section><p>hello</p></section>');
    const target = root.querySelector('p')!;
    const selector = computeSelector(target);
    expect(selector).toBe('section > p');
    expect(selector).not.toContain('body');
    expect(document.querySelector(selector)).toBe(target);
  });

  it('T-SEL5 无 id 回退链可在宿主页面复现', () => {
    const root = mount('<div><div><div><span class="x">deep</span></div></div></div>');
    const target = root.querySelector('span')!;
    const selector = computeSelector(target);
    expect(document.querySelector(selector)).toBe(target);
  });

  it('T-SEL6 同名兄弟唯一时省略 nth-of-type', () => {
    const root = mount('<div><p>only</p></div>');
    const target = root.querySelector('p')!;
    expect(computeSelector(target)).toBe('div > p');
    expect(document.querySelector('div > p')).toBe(target);
  });
});

describe('html-inject（srcDoc 注入）', () => {
  it('存在 </body> 时前置插入脚本，尾部结构不变', () => {
    const html = '<html><body><p>hi</p></body></html>';
    const out = injectSelectionScript(html, { annotate: true, token: 'tok' });
    expect(out.indexOf('data-zag-preview')).toBeLessThan(out.indexOf('</body>'));
    expect(out.endsWith('</body></html>')).toBe(true);
    expect(buildSelectionScript('tok')).toContain('var TOKEN = "tok"');
  });

  it('无 body 尾部追加；批注模式关闭原样返回', () => {
    const html = '<p>hi</p>';
    expect(injectSelectionScript(html, { annotate: true, token: 't' })).toContain('<script data-zag-preview="1">');
    expect(injectSelectionScript(html, { annotate: false, token: 't' })).toBe(html);
  });
});
