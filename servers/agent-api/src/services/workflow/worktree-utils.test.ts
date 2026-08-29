import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WORKTREE_DIR,
  resolveEffectiveWorktreeDir,
  expandTildeWith,
  normalizeForCompare,
  worktreeScopePrefix,
  sanitizeWorkspaceName,
} from './worktree-utils.js';

describe('worktree-utils', () => {
  describe('resolveEffectiveWorktreeDir (T-U4)', () => {
    it('returns the configured worktreeDir when set', () => {
      expect(resolveEffectiveWorktreeDir({ worktreeDir: '/data/wt' })).toBe('/data/wt');
    });

    it('falls back to DEFAULT_WORKTREE_DIR when unset or empty', () => {
      expect(resolveEffectiveWorktreeDir({ worktreeDir: null })).toBe(DEFAULT_WORKTREE_DIR);
      expect(resolveEffectiveWorktreeDir({ worktreeDir: '' })).toBe(DEFAULT_WORKTREE_DIR);
      expect(resolveEffectiveWorktreeDir({})).toBe(DEFAULT_WORKTREE_DIR);
      expect(resolveEffectiveWorktreeDir(null)).toBe(DEFAULT_WORKTREE_DIR);
    });
  });

  describe('expandTildeWith (T-U1)', () => {
    it('expands a leading ~/ with the reported homeDir', () => {
      expect(expandTildeWith('~/x', '/home/u')).toBe('/home/u/x');
    });

    it('returns the path unchanged when homeDir is absent', () => {
      expect(expandTildeWith('~/x', undefined)).toBe('~/x');
      expect(expandTildeWith('~/x', null)).toBe('~/x');
    });

    it('returns the path unchanged when it has no ~/ prefix', () => {
      expect(expandTildeWith('/abs/path', '/home/u')).toBe('/abs/path');
    });
  });

  describe('normalizeForCompare (T-U2)', () => {
    it('collapses backslashes to forward slashes', () => {
      expect(normalizeForCompare('a\\b\\c', 'linux')).toBe('a/b/c');
    });

    it('lowercases when platform is win32', () => {
      expect(normalizeForCompare('C:/Users/Foo/Wt', 'win32')).toBe('c:/users/foo/wt');
    });

    it('keeps case for non-win32', () => {
      expect(normalizeForCompare('/Home/U/X', 'linux')).toBe('/Home/U/X');
    });

    it('collapses dot segments to prevent path traversal bypass', () => {
      expect(normalizeForCompare('/wt/ws/../evil', 'linux')).toBe('/wt/evil');
    });
  });

  describe('worktreeScopePrefix (T-U3)', () => {
    it('expands ~, sanitizes workspace name, and appends trailing separator', () => {
      const prefix = worktreeScopePrefix('~/.zag/worktrees', 'My WS/名', '/home/u');
      expect(prefix).toBe(`/home/u/.zag/worktrees/${sanitizeWorkspaceName('My WS/名')}/`);
    });
  });
});