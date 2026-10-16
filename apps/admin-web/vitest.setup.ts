import '@testing-library/jest-dom/vitest';

window.matchMedia = window.matchMedia || (() => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});

// base-ui 浮层组件（Select/Dialog）在 jsdom 下依赖 ResizeObserver
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}
