import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerHarnessCommands } from '../../src/commands/harness.js';
import type { HarnessPrepareResult } from '../../src/harness/prepare.js';

function buildProgram(deps: Parameters<typeof registerHarnessCommands>[1] = {}) {
  const program = new Command();
  program.name('agent-gear').exitOverride();
  registerHarnessCommands(program, deps);
  return program;
}

const SUCCESS_RESULT: HarnessPrepareResult = {
  opencodeVersion: '1.2.3',
  env: {
    modelBaseUrl: 'http://admin-api:8002/v1',
    defaultWorkspace: '/root/workspace',
    modelCount: 2,
  },
  config: {
    path: '/root/.config/opencode/opencode.jsonc',
    created: true,
    modelCount: 2,
  },
};

describe('agent-gear harness command (T-AG15)', () => {
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
    delete process.env.ZAG_MODEL_API_KEY;
  });

  it('shows prepare in `agent-gear harness --help`', async () => {
    let output = '';
    const program = buildProgram();
    program.configureOutput({ writeOut: (text) => { output += text; }, writeErr: () => {} });

    await program.parseAsync(['node', 'agent-gear', 'harness', '--help']).catch(() => {});

    expect(output).toContain('prepare');
  });

  it('rejects unknown subcommands with a non-zero exit code', async () => {
    const program = buildProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });

    await expect(
      program.parseAsync(['node', 'agent-gear', 'harness', 'bogus']),
    ).rejects.toMatchObject({ exitCode: 1 });
  });

  it('prints a secret-free summary on success', async () => {
    const prepare = vi.fn(async () => SUCCESS_RESULT);
    const program = buildProgram({ prepare });

    await program.parseAsync(['node', 'agent-gear', 'harness', 'prepare']);

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
    const output = vi.mocked(console.log).mock.calls.flat().join(' ');
    expect(output).toContain('OpenCode harness prepared');
    expect(output).toContain('version=1.2.3');
    expect(output).not.toContain('zag_sk_');
  });

  it('exits non-zero and redacts secrets when prepare fails', async () => {
    process.env.ZAG_MODEL_API_KEY = 'zag_sk_super_secret';
    const prepare = vi.fn(async () => {
      throw new Error('failed with key zag_sk_super_secret');
    });
    const program = buildProgram({ prepare });

    await program.parseAsync(['node', 'agent-gear', 'harness', 'prepare']);

    expect(process.exitCode).toBe(1);
    const errors = vi.mocked(console.error).mock.calls.flat().join(' ');
    expect(errors).toContain('harness prepare failed');
    expect(errors).not.toContain('zag_sk_super_secret');
    expect(errors).toContain('***');
  });
});
