import { describe, it, expect } from 'vitest';
import { computeDiff, MAX_DIFF_LINES, DIFF_TRUNCATED_NOTICE } from '../diff';

describe('computeDiff', () => {
  it('should align inserted lines with new line numbers', () => {
    const lines = computeDiff('a\nb', 'a\nx\nb');

    expect(lines.map((l) => l.type)).toEqual(['same', 'added', 'same']);
    expect(lines[0]).toMatchObject({ oldLineNumber: 1, newLineNumber: 1 });
    expect(lines[1]).toMatchObject({ text: 'x', newLineNumber: 2 });
    expect(lines[1].oldLineNumber).toBeUndefined();
    expect(lines[2]).toMatchObject({ oldLineNumber: 2, newLineNumber: 3 });
  });

  it('should align removed lines with old line numbers', () => {
    const lines = computeDiff('a\nb\nc', 'a\nc');

    expect(lines.map((l) => l.type)).toEqual(['same', 'removed', 'same']);
    expect(lines[1]).toMatchObject({ text: 'b', oldLineNumber: 2 });
    expect(lines[1].newLineNumber).toBeUndefined();
    expect(lines[2]).toMatchObject({ oldLineNumber: 3, newLineNumber: 2 });
  });

  it('should render modification as removed then added', () => {
    const lines = computeDiff('a\nb', 'a\nc');

    expect(lines.map((l) => `${l.type}:${l.text}`)).toEqual([
      'same:a',
      'removed:b',
      'added:c',
    ]);
    expect(lines[1].oldLineNumber).toBe(2);
    expect(lines[2].newLineNumber).toBe(2);
  });

  it('should return empty result for two empty inputs', () => {
    expect(computeDiff('', '')).toEqual([]);
  });

  it('should mark every line as added when old text is empty', () => {
    const lines = computeDiff('', 'line1\nline2');

    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.type === 'added')).toBe(true);
    expect(lines.map((l) => l.newLineNumber)).toEqual([1, 2]);
    expect(lines.every((l) => l.oldLineNumber === undefined)).toBe(true);
  });

  it('should keep identical texts as same lines with both numbers', () => {
    const lines = computeDiff('a\nb', 'a\nb');

    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.type === 'same')).toBe(true);
    expect(lines[1]).toMatchObject({ oldLineNumber: 2, newLineNumber: 2 });
  });

  it('should keep the unchanged trailing line aligned instead of reporting a false modification', () => {
    // R-6：尾行无换行时不得把内容相同的行 4 误报为 removed+added
    const lines = computeDiff('1\n2\n3\n4', '1\n3\n4\n5');

    expect(lines.map((l) => `${l.type}:${l.text}`)).toEqual([
      'same:1',
      'removed:2',
      'same:3',
      'same:4',
      'added:5',
    ]);
    expect(lines.filter((l) => l.type === 'removed').map((l) => l.oldLineNumber)).toEqual([2]);
    expect(lines.filter((l) => l.type === 'added').map((l) => l.newLineNumber)).toEqual([4]);
    const sameLines = lines.filter((l) => l.type === 'same');
    expect(sameLines.map((l) => [l.oldLineNumber, l.newLineNumber])).toEqual([
      [1, 1],
      [3, 2],
      [4, 3],
    ]);
  });

  it('should treat a trailing newline difference as the same content (P2)', () => {
    const lines = computeDiff('a\nb\n', 'a\nb');

    expect(lines.every((l) => l.type === 'same')).toBe(true);
    expect(lines.map((l) => l.text)).toEqual(['a', 'b']);
  });

  it('should not report CRLF vs LF as a full-file rewrite (P3)', () => {
    const lines = computeDiff('a\r\nb\r\n', 'a\nb\n');

    expect(lines.every((l) => l.type === 'same')).toBe(true);
    expect(lines.map((l) => l.text)).toEqual(['a', 'b']);
  });

  it('should strip carriage returns from rendered line text (P4)', () => {
    const lines = computeDiff('a\r\nb\r\n', 'a\r\nc\r\n');

    expect(lines.map((l) => `${l.type}:${l.text}`)).toEqual(['same:a', 'removed:b', 'added:c']);
    expect(lines.every((l) => !l.text.includes('\r'))).toBe(true);
  });

  it('should preserve empty lines inside the content', () => {
    const lines = computeDiff('a\n\nb', 'a\n\nc');

    expect(lines.map((l) => `${l.type}:${l.text}`)).toEqual(['same:a', 'same:', 'removed:b', 'added:c']);
  });

  it('should truncate diffs longer than the limit and append a notice', () => {
    const oldText = Array.from({ length: MAX_DIFF_LINES + 10 }, (_, i) => `line${i}`).join('\n');
    const newText = `${oldText}\nline-extra`;

    const lines = computeDiff(oldText, newText);

    expect(lines).toHaveLength(MAX_DIFF_LINES + 1);
    const last = lines[lines.length - 1];
    expect(last.truncated).toBe(true);
    expect(last.text).toBe(DIFF_TRUNCATED_NOTICE);
  });
});
