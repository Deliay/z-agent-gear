import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerGithubCommands } from './github.js';

describe('registerGithubCommands', () => {
  it('registers github-token and forwards --cwd to the runner', async () => {
    const program = new Command();
    program.exitOverride();
    const run = vi.fn(async () => 0);
    registerGithubCommands(program, { runGithubTokenCommand: run });

    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(program.parseAsync(['node', 'agent-gear', 'github-token', '--cwd', '/repo'])).rejects.toThrow(
      'exit:0',
    );
    expect(run).toHaveBeenCalledWith({ cwd: '/repo' });
    expect(exit).toHaveBeenCalledWith(0);
    exit.mockRestore();
  });

  it('omits cwd when not provided', async () => {
    const program = new Command();
    program.exitOverride();
    const run = vi.fn(async () => 3);
    registerGithubCommands(program, { runGithubTokenCommand: run });

    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(program.parseAsync(['node', 'agent-gear', 'github-token'])).rejects.toThrow('exit:3');
    expect(run).toHaveBeenCalledWith({});
    exit.mockRestore();
  });
});
