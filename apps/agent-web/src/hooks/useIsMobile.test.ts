import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsMobile } from './useIsMobile';

let matchMediaCallback: (() => void) | null = null;

function mockMatchMedia(width: number) {
  const mql = {
    matches: width < 768,
    addEventListener: (_event: string, cb: () => void) => {
      matchMediaCallback = cb;
    },
    removeEventListener: () => {
      matchMediaCallback = null;
    },
  };
  vi.stubGlobal('matchMedia', vi.fn(() => mql));
  vi.stubGlobal('innerWidth', width);
}

function triggerMatchMediaChange() {
  if (matchMediaCallback) {
    act(() => {
      matchMediaCallback!();
    });
  }
}

describe('useIsMobile', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    matchMediaCallback = null;
  });

  it('should return false for desktop viewport (1024px)', () => {
    mockMatchMedia(1024);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it('should return true for mobile viewport (375px)', () => {
    mockMatchMedia(375);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it('should return false at exactly 768px (desktop boundary)', () => {
    mockMatchMedia(768);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it('should return true at 767px (mobile boundary)', () => {
    mockMatchMedia(767);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it('should update when viewport changes', () => {
    mockMatchMedia(1024);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    vi.stubGlobal('innerWidth', 375);
    triggerMatchMediaChange();
    expect(result.current).toBe(true);
  });
});
