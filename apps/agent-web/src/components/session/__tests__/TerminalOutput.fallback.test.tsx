import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@xterm/headless', () => ({
  Terminal: class {
    constructor() {
      throw new Error('terminal construction failed');
    }
  },
}));

import TerminalOutput from '../TerminalOutput';

describe('TerminalOutput fallback (T-TO9)', () => {
  it('T-TO9 should show degraded plain text when parsing fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(<TerminalOutput output={'\u001b[31mfallback text\u001b[0m'} />);

    const terminal = screen.getByTestId('terminal-output');
    await waitFor(() => expect(terminal.textContent).toContain('fallback text'));
    expect(terminal.textContent).not.toContain('\u001b');
    expect(warn).toHaveBeenCalled();
  });
});
