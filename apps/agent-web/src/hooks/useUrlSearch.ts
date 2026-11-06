import { useEffect, useState } from 'react';

/**
 * 响应式读取 `window.location.search`（router 无关，SPA 导航生效）。
 *
 * 订阅 `popstate` 并包装 `history.pushState/replaceState`——react-router 的 SPA
 * 导航最终经 pushState 更新 URL，包装后本 hook 的快照同步刷新；卸载还原。
 * 用于 Review 深链（裁决 13）在「同会话内点击侧边栏另一条目」时的响应式消费。
 */
export function useUrlSearch(): string {
  const [search, setSearch] = useState(() => window.location.search);

  useEffect(() => {
    const update = (): void => setSearch(window.location.search);
    window.addEventListener('popstate', update);
    const originalPush = window.history.pushState.bind(window.history);
    const originalReplace = window.history.replaceState.bind(window.history);
    window.history.pushState = (...args: Parameters<History['pushState']>) => {
      originalPush(...args);
      update();
    };
    window.history.replaceState = (...args: Parameters<History['replaceState']>) => {
      originalReplace(...args);
      update();
    };
    return () => {
      window.removeEventListener('popstate', update);
      window.history.pushState = originalPush;
      window.history.replaceState = originalReplace;
    };
  }, []);

  return search;
}
