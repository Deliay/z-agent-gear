import { describe, it, expect } from 'vitest';
import { collectFullHistory, mergeMessagesById } from '../session-messages';

function message(id: string) {
  return { id };
}

describe('mergeMessagesById', () => {
  it('should prepend older messages without duplicating existing ids', () => {
    const merged = mergeMessagesById([message('1'), message('2')], [message('2'), message('3')]);

    expect(merged.map((m) => m.id)).toEqual(['1', '2', '3']);
  });

  it('should keep the full order for a >25 message history export (R-1)', () => {
    const all = Array.from({ length: 60 }, (_, i) => message(String(i + 1)));
    const loaded = all.slice(35);
    const older = all.slice(0, 35);

    const merged = mergeMessagesById(older, loaded);

    expect(merged.map((m) => m.id)).toEqual(all.map((m) => m.id));
  });

  it('should not mutate the inputs', () => {
    const older = [message('1')];
    const current = [message('2')];

    mergeMessagesById(older, current);

    expect(older).toHaveLength(1);
    expect(current).toHaveLength(1);
  });
});

describe('collectFullHistory (R-1)', () => {
  const all = Array.from({ length: 60 }, (_, i) => message(String(i + 1)));

  function makeFetcher(received: string[][] = []) {
    return async (before: string, limit: number) => {
      const end = all.findIndex((m) => m.id === before);
      const start = Math.max(0, end - limit);
      const page = all.slice(start, end);
      received.push(page.map((m) => m.id));
      return page;
    };
  }

  it('should fetch every page before exporting a >25 message history', async () => {
    const received: string[][] = [];
    const loaded = all.slice(-25);

    const result = await collectFullHistory({
      loaded,
      hasMore: true,
      fetchPage: makeFetcher(received),
    });

    expect(result.messages.map((m) => m.id)).toEqual(all.map((m) => m.id));
    expect(result.fetchedPages).toBe(2);
    expect(received).toEqual([
      all.slice(10, 35).map((m) => m.id),
      all.slice(0, 10).map((m) => m.id),
    ]);
  });

  it('should skip fetching when there is no more history', async () => {
    const fetchPage = async () => {
      throw new Error('should not fetch');
    };

    const result = await collectFullHistory({ loaded: all, hasMore: false, fetchPage });

    expect(result.messages).toHaveLength(60);
    expect(result.fetchedPages).toBe(0);
  });

  it('should fail instead of silently truncating when maxPages is exceeded', async () => {
    const loaded = all.slice(-25);

    await expect(collectFullHistory({
      loaded,
      hasMore: true,
      maxPages: 1,
      fetchPage: makeFetcher(),
    })).rejects.toThrow(/max pages/);
  });
});
