import '@testing-library/jest-dom/vitest';

window.matchMedia = window.matchMedia || (() => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
