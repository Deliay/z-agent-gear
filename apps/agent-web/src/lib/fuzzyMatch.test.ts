import { describe, it, expect } from 'vitest';
import { fuzzyMatch, fuzzyMatchWithHighlight } from './fuzzyMatch';

describe('fuzzyMatch', () => {
  it('should match exact string', () => {
    expect(fuzzyMatch('connect', 'connect')).toBe(true);
  });

  it('should match prefix', () => {
    expect(fuzzyMatch('con', 'connect')).toBe(true);
  });

  it('should match sequential characters', () => {
    expect(fuzzyMatch('cnet', 'connect')).toBe(true);
  });

  it('should not match wrong order', () => {
    expect(fuzzyMatch('tnec', 'connect')).toBe(false);
  });

  it('should not match non-existent characters', () => {
    expect(fuzzyMatch('xyz', 'connect')).toBe(false);
  });

  it('should match empty query', () => {
    expect(fuzzyMatch('', 'connect')).toBe(true);
  });

  it('should be case insensitive', () => {
    expect(fuzzyMatch('CNET', 'connect')).toBe(true);
    expect(fuzzyMatch('cnet', 'CONNECT')).toBe(true);
  });

  it('should handle query longer than target', () => {
    expect(fuzzyMatch('connect_extra', 'connect')).toBe(false);
  });
});

describe('fuzzyMatchWithHighlight', () => {
  it('should return correct indices for sequential match', () => {
    const result = fuzzyMatchWithHighlight('cnet', 'connect');
    expect(result.matched).toBe(true);
    expect(result.indices).toEqual([0, 2, 4, 6]);
  });

  it('should return empty indices for empty query', () => {
    const result = fuzzyMatchWithHighlight('', 'connect');
    expect(result.matched).toBe(true);
    expect(result.indices).toEqual([]);
  });

  it('should return matched false for no match', () => {
    const result = fuzzyMatchWithHighlight('xyz', 'connect');
    expect(result.matched).toBe(false);
    expect(result.indices).toEqual([]);
  });

  it('should handle exact match', () => {
    const result = fuzzyMatchWithHighlight('connect', 'connect');
    expect(result.matched).toBe(true);
    expect(result.indices).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
