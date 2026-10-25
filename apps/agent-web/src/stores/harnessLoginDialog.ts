import { useSyncExternalStore } from 'react';
import type { HarnessLoginRequestDataFields } from '../graphql/types';

export type HarnessLoginResolution = 'succeeded' | 'cancelled' | 'expired' | 'failed';

export interface HarnessLoginDialogState {
  current: HarnessLoginRequestDataFields | null;
  queue: HarnessLoginRequestDataFields[];
}

const EMPTY: HarnessLoginDialogState = { current: null, queue: [] };
const MAX_QUEUE = 20;
let state: HarnessLoginDialogState = EMPTY;
const listeners = new Set<() => void>();

function emit(next: HarnessLoginDialogState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): HarnessLoginDialogState {
  return state;
}

function getServerSnapshot(): HarnessLoginDialogState {
  return EMPTY;
}

function sameRequest(a: HarnessLoginRequestDataFields | null, b: HarnessLoginRequestDataFields): boolean {
  if (!a || a.requestId !== b.requestId) return false;
  return (
    a.controllerId === b.controllerId &&
    a.serverType === b.serverType &&
    a.trigger === b.trigger &&
    a.url === b.url &&
    a.userCode === b.userCode &&
    a.expiresAt === b.expiresAt
  );
}

/** 出差下一个排队请求；队列空时整体清空 */
export function closeHarnessLoginDialog(): void {
  if (state.current === null && state.queue.length === 0) return;
  const [next, ...rest] = state.queue;
  emit(next ? { current: next, queue: rest } : EMPTY);
}

/** 幂等打开：同一 requestId 只更新数据，不重复渲染 */
export function openHarnessLoginDialog(request: HarnessLoginRequestDataFields): void {
  if (sameRequest(state.current, request)) return;
  if (state.current?.requestId === request.requestId) {
    emit({ current: request, queue: state.queue });
    return;
  }
  if (state.current === null) {
    emit({ current: request, queue: state.queue });
    return;
  }
  const index = state.queue.findIndex((item) => item.requestId === request.requestId);
  if (index >= 0) {
    if (sameRequest(state.queue[index], request)) return;
    const queue = [...state.queue];
    queue[index] = request;
    emit({ current: state.current, queue });
    return;
  }
  if (state.queue.length >= MAX_QUEUE) return;
  emit({ current: state.current, queue: [...state.queue, request] });
}

/** resolved 到达：命中当前/排队请求则移除并自动关闭，返回是否命中 */
export function resolveHarnessLoginDialog(requestId: string): boolean {
  if (state.current?.requestId === requestId) {
    closeHarnessLoginDialog();
    return true;
  }
  const queue = state.queue.filter((item) => item.requestId !== requestId);
  if (queue.length === state.queue.length) return false;
  emit({ current: state.current, queue });
  return true;
}

/** 测试隔离用 */
export function resetHarnessLoginDialog(): void {
  state = EMPTY;
}

export function useHarnessLoginDialogState(): HarnessLoginDialogState & {
  open: (request: HarnessLoginRequestDataFields) => void;
  close: () => void;
  resolve: (requestId: string) => boolean;
} {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    ...snapshot,
    open: openHarnessLoginDialog,
    close: closeHarnessLoginDialog,
    resolve: resolveHarnessLoginDialog,
  };
}
