import { useSyncExternalStore } from 'react';
import type { AnnotationBatch } from '../lib/preview/types';

/**
 * 提示词片段组装 store（提案 §5.2 实现点 4/12，裁决 1/4）。
 *
 * 预览组件「确认回传」→ `appendPart`（origin 标注的 text part）；
 * InputBox 消费同一 store（同 sessionId）。手写 useSyncExternalStore 模式，
 * 按 sessionId 隔离（工厂 + destroy 清理）。
 */

export interface ComposerPart {
  id: string;
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
  name?: string;
  /** 批注回传来源（来源徽标展示与悬停预览） */
  origin?: AnnotationBatch;
}

export interface PromptComposerApi {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => { parts: ComposerPart[] };
  appendPart: (part: ComposerPart) => void;
  removePart: (id: string) => void;
  clear: () => void;
  destroy: () => void;
}

const composerStores = new Map<string, PromptComposerApi>();

function createComposerStore(): PromptComposerApi {
  let parts: ComposerPart[] = [];
  const listeners = new Set<() => void>();
  const emit = (next: ComposerPart[]): void => {
    parts = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => ({ parts }),
    appendPart(part) {
      emit([...parts, part]);
    },
    removePart(id) {
      emit(parts.filter((part) => part.id !== id));
    },
    clear() {
      emit([]);
    },
    destroy() {
      listeners.clear();
    },
  };
}

export function getPromptComposer(sessionId: string): PromptComposerApi {
  let store = composerStores.get(sessionId);
  if (!store) {
    store = createComposerStore();
    composerStores.set(sessionId, store);
  }
  return store;
}

export function destroyPromptComposer(sessionId: string): void {
  const store = composerStores.get(sessionId);
  if (store) {
    store.destroy();
    composerStores.delete(sessionId);
  }
}

const EMPTY_COMPOSER: { parts: ComposerPart[] } = { parts: [] };

export function usePromptComposer(sessionId: string): PromptComposerApi & { parts: ComposerPart[] } {
  const store = getPromptComposer(sessionId);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, () => EMPTY_COMPOSER);
  return { ...snapshot, ...store };
}
