/**
 * HtmlPreview srcDoc 注入模板（提案 §5.2 实现点 2）。
 *
 * 在原始 HTML 的 `</body>` 前（不存在则尾部追加）注入选择脚本；
 * 脚本携带每次挂载的随机令牌，postMessage 回传时父级校验令牌与来源。
 */

export interface HtmlInjectOptions {
  /** 批注模式：注入选择脚本 */
  annotate: boolean;
  /** 每次挂载的随机令牌 */
  token: string;
}

/** 生成注入用选择脚本（与 html-selector.ts 的 computeSelector 同源算法） */
export function buildSelectionScript(token: string): string {
  return `<script data-zag-preview="1">
(function () {
  var TOKEN = ${JSON.stringify(token)};
  function esc(v) { return String(v).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\\^\`{|}~])/g, '\\\\$1'); }
  function selectorOf(el) {
    var parts = [];
    var current = el;
    while (current && current.tagName !== 'BODY' && current.parentElement) {
      if (current.id) { parts.unshift('#' + esc(current.id)); break; }
      var testId = current.getAttribute('data-testid');
      if (testId) { parts.unshift('[data-testid="' + testId.replace(/"/g, '\\\\"') + '"]'); break; }
      var parent = current.parentElement;
      var siblings = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === current.tagName; });
      if (siblings.length === 1) {
        parts.unshift(current.tagName.toLowerCase());
      } else {
        parts.unshift(current.tagName.toLowerCase() + ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')');
      }
      current = parent;
    }
    return parts.join(' > ');
  }
  var selected = {};
  document.addEventListener('mouseover', function (e) {
    var el = e.target;
    if (!el || el === document.body || !el.tagName) return;
    el.setAttribute('data-zag-hover', '1');
  }, true);
  document.addEventListener('mouseout', function (e) {
    if (e.target && e.target.removeAttribute) e.target.removeAttribute('data-zag-hover');
  }, true);
  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!el || el === document.body || !el.tagName) return;
    e.preventDefault();
    e.stopPropagation();
    var selector = selectorOf(el);
    if (selected[selector]) {
      delete selected[selector];
      el.removeAttribute('data-zag-selected');
    } else {
      selected[selector] = true;
      el.setAttribute('data-zag-selected', '1');
    }
    var innerHtml = el.innerHTML || '';
    var truncated = false;
    if (innerHtml.length > 4000) { innerHtml = innerHtml.slice(0, 4000); truncated = true; }
    window.parent.postMessage({
      zagPreview: true,
      token: TOKEN,
      type: 'select',
      payload: { selector: selector, innerHtml: innerHtml, truncated: truncated, selected: !!selected[selector] }
    }, '*');
  }, true);
})();
</script>`;
}

/**
 * 构造 srcDoc：存在 `</body>`（不区分大小写）时前置插入脚本，否则尾部追加。
 * 批注模式关闭时原样返回（预览零开销）。
 */
export function injectSelectionScript(html: string, options: HtmlInjectOptions): string {
  if (!options.annotate) return html;
  const script = buildSelectionScript(options.token);
  const closeIndex = html.search(/<\/body\s*>/i);
  if (closeIndex >= 0) {
    return html.slice(0, closeIndex) + script + html.slice(closeIndex);
  }
  return html + script;
}

/** 每次挂载的随机令牌 */
export function generateToken(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
