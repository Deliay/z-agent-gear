/** 合并更早的历史页与当前已加载消息（按 id 去重，历史在前） */
export function mergeMessagesById<T extends { id: string }>(older: T[], current: T[]): T[] {
  const existingIds = new Set(current.map((message) => message.id));
  const uniqueOlder = older.filter((message) => !existingIds.has(message.id));
  return [...uniqueOlder, ...current];
}

export interface CollectFullHistoryOptions<T extends { id: string }> {
  /** 当前已加载的消息（SSE 首帧窗口） */
  loaded: T[];
  /** 是否还有更早历史 */
  hasMore: boolean;
  /** 单页条数，默认 25（与 SSE/加载更多口径一致） */
  pageSize?: number;
  /** 最大页数保护，默认 200 */
  maxPages?: number;
  /** 按 before 游标拉取一页更早历史 */
  fetchPage: (before: string, limit: number) => Promise<T[]>;
}

export interface CollectFullHistoryResult<T> {
  messages: T[];
  /** 实际拉取的页数 */
  fetchedPages: number;
}

/**
 * 导出前拉全历史：按 before 游标循环分页直至无更多数据（R-1）。
 * 达到 maxPages 仍未结束时抛错，调用方必须显式失败而不是静默导出残缺对话。
 */
export async function collectFullHistory<T extends { id: string }>({
  loaded,
  hasMore,
  pageSize = 25,
  maxPages = 200,
  fetchPage,
}: CollectFullHistoryOptions<T>): Promise<CollectFullHistoryResult<T>> {
  if (!hasMore || loaded.length === 0) {
    return { messages: loaded, fetchedPages: 0 };
  }

  let cursor = loaded[0]?.id;
  let collected: T[] = [];
  let fetchedPages = 0;

  while (cursor) {
    if (fetchedPages >= maxPages) {
      throw new Error('history pagination exceeded max pages');
    }
    const page = await fetchPage(cursor, pageSize);
    fetchedPages += 1;
    if (page.length === 0) {
      return { messages: mergeMessagesById(collected, loaded), fetchedPages };
    }
    collected = [...page, ...collected];
    const nextCursor = page[0]?.id;
    if (page.length < pageSize || !nextCursor || nextCursor === cursor) {
      return { messages: mergeMessagesById(collected, loaded), fetchedPages };
    }
    cursor = nextCursor;
  }

  return { messages: mergeMessagesById(collected, loaded), fetchedPages };
}
