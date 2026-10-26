import { describe, it, expect, vi } from 'vitest';
import { DshCliError, verifyDshCli } from './dsh-cli.js';
import type { CommandRunner } from './opencode-cli.js';

describe('verifyDshCli (T-CLI1)', () => {
  it('runs `dsh --version` and returns the prerelease version unchanged', async () => {
    const runner = vi.fn<CommandRunner>(async () => ({ stdout: '0.1.2-alpha.2\n', stderr: '' }));

    await expect(verifyDshCli(runner)).resolves.toBe('0.1.2-alpha.2');
    expect(runner).toHaveBeenCalledWith('dsh', ['--version']);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('accepts the exact pinned version (v prefix / command prefix tolerated)', async () => {
    const runner = vi.fn<CommandRunner>(async () => ({ stdout: 'v0.1.2-alpha.2\n', stderr: '' }));
    await expect(verifyDshCli(runner, '0.1.2-alpha.2')).resolves.toBe('0.1.2-alpha.2');

    const prefixed = vi.fn<CommandRunner>(async () => ({ stdout: 'dsh 0.1.2-alpha.2\n', stderr: '' }));
    await expect(verifyDshCli(prefixed, '0.1.2-alpha.2')).resolves.toBe('dsh 0.1.2-alpha.2');
  });

  it('fails on a version mismatch without leaking secrets', async () => {
    const runner = vi.fn<CommandRunner>(async () => ({ stdout: '0.1.1\n', stderr: '' }));
    let error: unknown;
    try {
      await verifyDshCli(runner, '0.1.2-alpha.2');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(DshCliError);
    const message = (error as Error).message;
    expect(message).toContain('version mismatch');
    expect(message).toContain('0.1.2-alpha.2');
    expect(message).toContain('0.1.1');
  });

  it('fails when dsh prints no version output', async () => {
    const runner = vi.fn<CommandRunner>(async () => ({ stdout: '  \n', stderr: '' }));
    await expect(verifyDshCli(runner)).rejects.toBeInstanceOf(DshCliError);
  });

  it('fails when the dsh command is missing', async () => {
    const runner = vi.fn<CommandRunner>(async () => {
      throw new Error('spawn dsh ENOENT');
    });

    let error: unknown;
    try {
      await verifyDshCli(runner);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DshCliError);
    expect((error as Error).message).toContain('dsh --version');
    expect((error as Error).message).toContain('ENOENT');
  });
});
