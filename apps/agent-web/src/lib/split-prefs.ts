/**
 * 会话分屏偏好（提案 §5.2 实现点 5）。
 *
 * `localStorage['session-split-mode:{sessionId}']` 按会话记忆；
 * 取值 `chat | horizontal | vertical`，非法值回退 `chat`。
 */

export type SplitMode = 'chat' | 'horizontal' | 'vertical';

export const SPLIT_MODE_KEY_PREFIX = 'session-split-mode:';

const VALID_MODES: readonly SplitMode[] = ['chat', 'horizontal', 'vertical'];

export function getSplitMode(sessionId: string): SplitMode {
  try {
    const raw = localStorage.getItem(SPLIT_MODE_KEY_PREFIX + sessionId);
    if (raw && (VALID_MODES as readonly string[]).includes(raw)) {
      return raw as SplitMode;
    }
  } catch { /* localStorage 不可用时回退 chat */ }
  return 'chat';
}

export function setSplitMode(sessionId: string, mode: SplitMode): void {
  try {
    if (!(VALID_MODES as readonly string[]).includes(mode)) return;
    localStorage.setItem(SPLIT_MODE_KEY_PREFIX + sessionId, mode);
  } catch { /* 忽略持久化失败 */ }
}
