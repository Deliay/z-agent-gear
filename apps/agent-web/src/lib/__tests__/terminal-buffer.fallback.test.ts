import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@xterm/headless', () => ({
  Terminal: class {
    constructor() {
      throw new Error('terminal construction failed');
    }
  },
}));

import { renderTerminalOutput } from '../terminal-buffer';

describe('terminal-buffer fallback (T-TB18)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('T-TB18 should degrade to plain text when terminal parsing throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const lines = await renderTerminalOutput('\u001b[31mred\u001b[0m\n\nsecond\u001b[2K');

    expect(lines.map((line) => line.spans.map((span) => span.text).join(''))).toEqual([
      'red',
      '',
      'second',
    ]);
    expect(warn).toHaveBeenCalled();
  });
});
