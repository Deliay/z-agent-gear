import { describe, it, expect } from 'vitest';
import { BOOTSTRAP_ERROR_MESSAGE, renderBootstrapFallback } from '../bootstrap';

describe('renderBootstrapFallback', () => {
  it('renders an accessible error message into the root element', () => {
    const root = document.createElement('div');

    renderBootstrapFallback(root);

    const alert = root.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toBe(BOOTSTRAP_ERROR_MESSAGE);
  });

  it('accepts a custom message', () => {
    const root = document.createElement('div');
    renderBootstrapFallback(root, 'custom failure');
    expect(root.textContent).toBe('custom failure');
  });

  it('does nothing when the root element is missing', () => {
    expect(() => renderBootstrapFallback(null)).not.toThrow();
  });
});
