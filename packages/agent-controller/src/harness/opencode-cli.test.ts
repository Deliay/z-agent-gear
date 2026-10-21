import { describe, it, expect, vi } from 'vitest';
import {
  OpencodeCliError,
  extractVersion,
  verifyOpencodeCli,
  type CommandRunner,
} from './opencode-cli.js';

describe('verifyOpencodeCli (T-AG8)', () => {
  it('runs `opencode --version` and returns the version', async () => {
    const runner = vi.fn<CommandRunner>(async () => ({ stdout: '1.2.3\n', stderr: '' }));

    await expect(verifyOpencodeCli(runner)).resolves.toBe('1.2.3');
    expect(runner).toHaveBeenCalledWith('opencode', ['--version']);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('falls back to `opencode -v` for legacy CLIs', async () => {
    const runner = vi.fn<CommandRunner>(async (_command, args) => {
      if (args[0] === '--version') throw new Error('unknown option');
      return { stdout: 'v0.9.1\n', stderr: '' };
    });

    await expect(verifyOpencodeCli(runner)).resolves.toBe('0.9.1');
    expect(runner).toHaveBeenNthCalledWith(1, 'opencode', ['--version']);
    expect(runner).toHaveBeenNthCalledWith(2, 'opencode', ['-v']);
  });

  it('falls back to `-v` when `--version` prints no version', async () => {
    const runner = vi.fn<CommandRunner>(async (_command, args) =>
      args[0] === '--version'
        ? { stdout: '   \n', stderr: '' }
        : { stdout: '2.0.0\n', stderr: '' },
    );

    await expect(verifyOpencodeCli(runner)).resolves.toBe('2.0.0');
  });

  it('throws a version-check error when both commands fail', async () => {
    const runner = vi.fn<CommandRunner>(async () => {
      throw new Error('spawn opencode ENOENT');
    });

    let error: unknown;
    try {
      await verifyOpencodeCli(runner);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(OpencodeCliError);
    const message = (error as Error).message;
    expect(message).toContain('version check failed');
    expect(message).toContain('opencode --version');
    expect(message).toContain('opencode -v');
    expect(message).toContain('ENOENT');
  });

  it('C-5: validates the expected pinned version (tolerates v prefix and command output prefix)', async () => {
    const runner = vi.fn<CommandRunner>(async () => ({ stdout: 'v2.1.1\n', stderr: '' }));
    await expect(verifyOpencodeCli(runner, '2.1.1')).resolves.toBe('2.1.1');

    const prefixed = vi.fn<CommandRunner>(async () => ({ stdout: 'opencode 2.1.1\n', stderr: '' }));
    await expect(verifyOpencodeCli(prefixed, '2.1.1')).resolves.toBe('opencode 2.1.1');
  });

  it('C-5: throws immediately on a pinned version mismatch', async () => {
    const runner = vi.fn<CommandRunner>(async () => ({ stdout: '2.0.0\n', stderr: '' }));

    await expect(verifyOpencodeCli(runner, '2.1.1')).rejects.toThrow(
      /version mismatch: expected 2\.1\.1, got 2\.0\.0/,
    );
    // 不匹配即失败，不再退回 `-v`
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('reads the version from stderr when stdout is empty', () => {
    expect(extractVersion('', 'opencode 1.0.0\n')).toBe('opencode 1.0.0');
    expect(extractVersion('\n\n3.2.1\n')).toBe('3.2.1');
    expect(extractVersion('   ')).toBeUndefined();
  });
});
