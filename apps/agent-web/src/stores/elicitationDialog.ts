import { useSyncExternalStore } from 'react';

/**
 * 问询弹窗打开权共享状态（会话内 Banner 与全局待办面板的唯一互斥源）。
 *
 * 只存「当前打开的问询 todo id + 打开方」，弹窗数据由消费方从全量 todos 派生
 * （不过滤 resolution），保证轮询拿到终态后弹窗就地收敛，而不是随 pending 清空被卸载。
 */
export type ElicitationDialogOwner = 'banner' | 'todo';

interface ElicitationDialogState {
  todoId: string | null;
  owner: ElicitationDialogOwner | null;
}

let state: ElicitationDialogState = { todoId: null, owner: null };
const listeners = new Set<() => void>();

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
  return { todoId: null, owner: null };
}

export function openElicitationDialog(todoId: string, owner: ElicitationDialogOwner): void {
  emit({ todoId, owner });
}

export function closeElicitationDialog(): void {
  if (state.todoId === null && state.owner === null) return;
  emit({ todoId: null, owner: null });
}

/** 测试隔离用：直接清空（不发无效通知） */
export function resetElicitationDialog(): void {
  state = { todoId: null, owner: null };
}

export function useElicitationDialogState(): ElicitationDialogState & {
  open: (todoId: string, owner: ElicitationDialogOwner) => void;
  close: () => void;
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    ...snapshot,
    open: openElicitationDialog,
    close: closeElicitationDialog,
  };
}
