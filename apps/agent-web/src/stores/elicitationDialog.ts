import { useSyncExternalStore } from 'react';
import type { TodoItemData } from '../graphql/types';

/**
 * 问询弹窗打开权共享状态（会话内 Banner 与全局待办面板的唯一互斥源）。
 *
 * 状态 = 当前 todo id + 打开方 + 打开时快照：
 * - 弹窗数据优先取列表最新数据，列表已移除（TTL/limit 挤出）时退回快照并标记 missing，
 *   由弹窗展示「已失效」终态而不是连同表单瞬间卸载；
 * - close(owner) 带 owner 守卫，避免非持有方误关；
 * - 未 resolved 的 id 不会永久阻塞后续 immediate 自动弹窗（missing 时放行）。
 */
export type ElicitationDialogOwner = 'banner' | 'todo';

interface ElicitationDialogState {
  todoId: string | null;
  owner: ElicitationDialogOwner | null;
  snapshot: TodoItemData | null;
}

let state: ElicitationDialogState = { todoId: null, owner: null, snapshot: null };
const listeners = new Set<() => void>();
// 表单草稿按 requestId 存取：Banner/TodoList 切换持有方导致弹窗重挂载时保留用户已填内容。
// 上限 50 条（Map 按插入序淘汰最旧），避免长会话/异常 requestId 无界增长。
const MAX_DRAFTS = 50;
const drafts = new Map<string, Record<string, unknown>>();
const EMPTY: ElicitationDialogState = { todoId: null, owner: null, snapshot: null };

function emit(next: ElicitationDialogState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ElicitationDialogState {
  return state;
}

function getServerSnapshot(): ElicitationDialogState {
  return EMPTY;
}

export function openElicitationDialog(todo: TodoItemData, owner: ElicitationDialogOwner): void {
  emit({ todoId: todo.id, owner, snapshot: todo });
}

/** owner 缺省时强制关闭（仅测试/重置用）；传入 owner 时只有持有方可关闭 */
export function closeElicitationDialog(owner?: ElicitationDialogOwner): void {
  if (state.todoId === null) return;
  if (owner && state.owner !== owner) return;
  emit(EMPTY);
}

/** 表单草稿（跨 owner 切换保留） */
export function getElicitationDraft(key: string): Record<string, unknown> {
  return drafts.get(key) ?? {};
}

export function saveElicitationDraft(key: string, values: Record<string, unknown>): void {
  drafts.delete(key);
  drafts.set(key, values);
  while (drafts.size > MAX_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (oldest === undefined) break;
    drafts.delete(oldest);
  }
}

/** 用列表最新数据刷新打开中的快照（保留终态：todo 随后被 TTL 移除时仍显示已接受/已拒绝） */
export function syncElicitationSnapshot(todo: TodoItemData): void {
  if (state.todoId !== todo.id || !state.snapshot) return;
  if (state.snapshot.resolution === todo.resolution) return;
  emit({ ...state, snapshot: todo });
}

export function clearElicitationDraft(key: string): void {
  drafts.delete(key);
}

/** 测试隔离用 */
export function resetElicitationDialog(): void {
  state = EMPTY;
  drafts.clear();
}

export function useElicitationDialogState(): ElicitationDialogState & {
  open: (todo: TodoItemData, owner: ElicitationDialogOwner) => void;
  close: (owner?: ElicitationDialogOwner) => void;
  sync: (todo: TodoItemData) => void;
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    ...snapshot,
    open: openElicitationDialog,
    close: closeElicitationDialog,
    sync: syncElicitationSnapshot,
  };
}
