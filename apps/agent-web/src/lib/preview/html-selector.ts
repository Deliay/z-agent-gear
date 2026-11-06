/**
 * HTML 元素 selector 计算（提案 §5.2 实现点 2）。
 *
 * 与 HtmlPreview 注入脚本同源生成：优先 `#id` → `[data-testid]` →
 * `tag:nth-of-type(n)` 链至 body；产物在宿主页面可用于 `querySelector` 复现。
 * 纯函数，不接触 DOM 之外的状态。
 */

function cssEscapeIdent(value: string): string {
  return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\]^`{|}~])/g, '\\$1');
}

/** 计算单个元素相对 body 的稳定 selector 链 */
export function computeSelector(element: Element, root: ParentNode = document.body): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== root && current.parentElement) {
    if (current.id) {
      parts.unshift(`#${cssEscapeIdent(current.id)}`);
      break;
    }
    const testId = current.getAttribute('data-testid');
    if (testId) {
      parts.unshift(`[data-testid="${testId.replace(/"/g, '\\"')}"]`);
      break;
    }
    const parent: Element = current.parentElement;
    const siblings = Array.from(parent.children).filter(
      (child) => child.tagName === current!.tagName,
    );
    if (siblings.length === 1) {
      parts.unshift(current.tagName.toLowerCase());
    } else {
      const index = siblings.indexOf(current) + 1;
      parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${index})`);
    }
    current = parent;
  }
  return parts.join(' > ');
}
