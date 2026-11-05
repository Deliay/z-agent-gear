import { useSyncExternalStore } from 'react';

/**
 * 预览区标签页状态机（提案 §5.2 实现点 6、裁决 1）。
 *
 * 手写 `useSyncExternalStore` store（不引入 zustand），按 sessionId 隔离：
 * 模块级 `Map<sessionId, StoreApi>` 工厂 `usePreviewStore(sessionId)`，
 * `SessionView` 卸载时 `destroy(sessionId)` 清理防泄漏。
 *
 * 语义：写文件 → pinned tab 就地更新；读文件 → 至多一个共享预览 tab 替换并激活；
 * Review → 幂等打开；关闭激活回退邻近 tab。状态迁移收敛为纯函数 `reduceTabs`。
 */

export interface PreviewFileTab {
  id: string;
  kind: 'file';
  filePath: string;
  pinned: boolean;
  focusLine?: number;
  diff?: { oldText: string | null; newText: string };
}

export interface PreviewReviewTab {
  id: string;
  kind: 'review';
  reviewId: string;
}

export type PreviewTab = PreviewFileTab | PreviewReviewTab;

export interface PreviewState {
  tabs: PreviewTab[];
  activeTabId: string | null;
}

export interface OpenFileInput {
  filePath: string;
  pinned: boolean;
  focusLine?: number;
  diff?: { oldText: string | null; newText: string };
  activate?: boolean;
}

export type PreviewAction =
  | { type: 'openFile'; input: OpenFileInput }
  | { type: 'openReview'; reviewId: string }
  | { type: 'closeTab'; id: string }
  | { type: 'setActive'; id: string };

export const emptyPreviewState: PreviewState = { tabs: [], activeTabId: null };

let tabSeq = 0;
function nextTabId(): string {
  tabSeq += 1;
  return `tab-${Date.now()}-${tabSeq}`;
}

/** 标签页状态迁移纯函数（T-TABS1~6 语义矩阵） */
export function reduceTabs(state: PreviewState, action: PreviewAction): PreviewState {
  switch (action.type) {
    case 'openFile': {
      const { input } = action;
      const activate = input.activate !== false;
      if (input.pinned) {
        // 写文件：同 filePath 的 pinned tab 已存在则就地更新（不新开）
        const existing = state.tabs.find(
          (tab): tab is PreviewFileTab => tab.kind === 'file' && tab.pinned && tab.filePath === input.filePath,
        );
        if (existing) {
          const updated: PreviewFileTab = {
            ...existing,
            focusLine: input.focusLine ?? existing.focusLine,
            diff: input.diff ?? existing.diff,
          };
          return {
            tabs: state.tabs.map((tab) => (tab.id === existing.id ? updated : tab)),
            activeTabId: activate ? existing.id : state.activeTabId,
          };
        }
        const tab: PreviewFileTab = {
          id: nextTabId(),
          kind: 'file',
          filePath: input.filePath,
          pinned: true,
          focusLine: input.focusLine,
          diff: input.diff,
        };
        return { tabs: [...state.tabs, tab], activeTabId: activate ? tab.id : state.activeTabId };
      }
      // 读文件：至多一个共享预览 tab（VSCode 预览语义），已存在则替换并激活
      const preview = state.tabs.find((tab): tab is PreviewFileTab => tab.kind === 'file' && !tab.pinned);
      if (preview) {
        const updated: PreviewFileTab = {
          ...preview,
          filePath: input.filePath,
          focusLine: input.focusLine,
          diff: input.diff,
        };
        return {
          tabs: state.tabs.map((tab) => (tab.id === preview.id ? updated : tab)),
          activeTabId: activate ? preview.id : state.activeTabId,
        };
      }
      const tab: PreviewFileTab = {
        id: nextTabId(),
        kind: 'file',
        filePath: input.filePath,
        pinned: false,
        focusLine: input.focusLine,
        diff: input.diff,
      };
      return { tabs: [...state.tabs, tab], activeTabId: activate ? tab.id : state.activeTabId };
    }
    case 'openReview': {
      const existing = state.tabs.find(
        (tab): tab is PreviewReviewTab => tab.kind === 'review' && tab.reviewId === action.reviewId,
      );
      if (existing) {
        return { ...state, activeTabId: existing.id };
      }
      const tab: PreviewReviewTab = { id: nextTabId(), kind: 'review', reviewId: action.reviewId };
      return { tabs: [...state.tabs, tab], activeTabId: tab.id };
    }
    case 'closeTab': {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== action.id);
      if (state.activeTabId !== action.id) {
        return { ...state, tabs };
      }
      // 关闭激活 tab：回退邻近（右侧优先，否则左侧）
      const neighbor = tabs[index] ?? tabs[index - 1] ?? null;
      return { tabs, activeTabId: neighbor ? neighbor.id : null };
    }
    case 'setActive': {
      if (!state.tabs.some((tab) => tab.id === action.id)) return state;
      return { ...state, activeTabId: action.id };
    }
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// 手写 store 工厂（按 sessionId 隔离；useSyncExternalStore 模式对齐 stores/workspace.ts）
// ---------------------------------------------------------------------------

export interface PreviewStoreApi {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => PreviewStoreSnapshot;
  openFile: (input: OpenFileInput) => void;
  openReview: (reviewId: string) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  setLive: (live: boolean) => void;
  destroy: () => void;
}

export interface PreviewStoreSnapshot extends PreviewState {
  live: boolean;
}

const stores = new Map<string, PreviewStoreApi>();

function createStore(): PreviewStoreApi {
  let state: PreviewStoreSnapshot = { ...emptyPreviewState, live: false };
  const listeners = new Set<() => void>();
  const emit = (next: PreviewStoreSnapshot): void => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    openFile(input) {
      emit({ ...state, ...reduceTabs(state, { type: 'openFile', input }) });
    },
    openReview(reviewId) {
      emit({ ...state, ...reduceTabs(state, { type: 'openReview', reviewId }) });
    },
    closeTab(id) {
      emit({ ...state, ...reduceTabs(state, { type: 'closeTab', id }) });
    },
    setActive(id) {
      emit({ ...state, ...reduceTabs(state, { type: 'setActive', id }) });
    },
    setLive(live) {
      emit({ ...state, live });
    },
    destroy() {
      listeners.clear();
    },
  };
}

/** 按 sessionId 获取（或创建）预览 store */
export function getPreviewStore(sessionId: string): PreviewStoreApi {
  let store = stores.get(sessionId);
  if (!store) {
    store = createStore();
    stores.set(sessionId, store);
  }
  return store;
}

/** SessionView 卸载清理（裁决 1） */
export function destroyPreviewStore(sessionId: string): void {
  const store = stores.get(sessionId);
  if (store) {
    store.destroy();
    stores.delete(sessionId);
  }
}

const EMPTY_SNAPSHOT: PreviewStoreSnapshot = { ...emptyPreviewState, live: false };

/** React hook：按 sessionId 隔离的预览 store */
export function usePreviewStore(sessionId: string): PreviewStoreApi & PreviewStoreSnapshot {
  const store = getPreviewStore(sessionId);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, () => EMPTY_SNAPSHOT);
  return { ...snapshot, ...store };
}
