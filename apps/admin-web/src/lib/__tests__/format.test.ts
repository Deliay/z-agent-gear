import { describe, it, expect } from 'vitest';
import { formatOnlineDuration, formatDuration } from '@/lib/format';

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(0)).toBe('0秒');
    expect(formatDuration(45_000)).toBe('45秒');
    expect(formatDuration(90_000)).toBe('1分30秒');
    expect(formatDuration(7_500_000)).toBe('2小时5分');
  });

  it('never returns a negative duration', () => {
    expect(formatDuration(-1000)).toBe('0秒');
  });
});

describe('formatOnlineDuration (verdict 15)', () => {
  it('uses now - connectedAt while still online', () => {
    const now = new Date('2026-10-14T12:05:00Z').getTime();
    expect(
      formatOnlineDuration(
        { connectedAt: '2026-10-14T10:00:00Z', exitedAt: null },
        now,
      ),
    ).toBe('2小时5分');
  });

  it('uses exitedAt - connectedAt once exited', () => {
    expect(
      formatOnlineDuration({
        connectedAt: '2026-10-14T10:00:00Z',
        exitedAt: '2026-10-14T10:30:00Z',
      }),
    ).toBe('30分0秒');
  });

  it('returns "-" when the container never connected', () => {
    expect(formatOnlineDuration({ connectedAt: null, exitedAt: null })).toBe('-');
  });

  it('returns "-" for invalid timestamps', () => {
    expect(
      formatOnlineDuration({ connectedAt: 'not-a-date', exitedAt: null }, Date.now()),
    ).toBe('-');
  });
});
