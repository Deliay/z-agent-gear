// 应用启动兜底：localStorage 受限 / 远端配置探测异常时，避免因未捕获异常白屏。

export const BOOTSTRAP_ERROR_MESSAGE =
  '管理后台初始化失败。请确认浏览器未禁用本地存储（localStorage）后刷新重试。'

/** 将启动失败信息渲染到根节点（纯 DOM，不依赖 React，保证兜底生效）。 */
export function renderBootstrapFallback(
  root: HTMLElement | null,
  message: string = BOOTSTRAP_ERROR_MESSAGE,
): void {
  if (!root) return;
  const wrapper = document.createElement('div');
  wrapper.setAttribute('role', 'alert');
  wrapper.textContent = message;
  root.replaceChildren(wrapper);
}
