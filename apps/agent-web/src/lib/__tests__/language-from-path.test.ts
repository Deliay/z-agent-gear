import { describe, it, expect } from 'vitest';
import { languageFromPath } from '../language-from-path';

describe('languageFromPath', () => {
  it('should map common extensions to Prism languages', () => {
    expect(languageFromPath('src/main.ts')).toBe('typescript');
    expect(languageFromPath('src/App.tsx')).toBe('tsx');
    expect(languageFromPath('src/index.js')).toBe('javascript');
    expect(languageFromPath('server/app.py')).toBe('python');
    expect(languageFromPath('src/lib.rs')).toBe('rust');
    expect(languageFromPath('cmd/main.go')).toBe('go');
    expect(languageFromPath('config/app.yaml')).toBe('yaml');
    expect(languageFromPath('README.md')).toBe('markdown');
  });

  it('should be case insensitive', () => {
    expect(languageFromPath('SRC/MAIN.TS')).toBe('typescript');
    expect(languageFromPath('Dockerfile')).toBe('docker');
  });

  it('should fall back to text for unknown or missing extensions', () => {
    expect(languageFromPath('src/data.unknownext')).toBe('text');
    expect(languageFromPath('Makefile')).toBe('text');
    expect(languageFromPath(undefined)).toBe('text');
    expect(languageFromPath('')).toBe('text');
  });
});
