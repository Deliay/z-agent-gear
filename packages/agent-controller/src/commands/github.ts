import type { Command } from 'commander';
import {
  runGithubTokenCommand,
  type RunGithubTokenCommandOptions,
} from '../github/project-token.js';

export interface RegisterGithubCommandsDeps {
  runGithubTokenCommand?: (options?: RunGithubTokenCommandOptions) => Promise<number>;
}

/**
 * 注册 `agent-gear github` 命令组。
 *
 * ```
 * agent-gear github-token [--cwd <dir>]   # 按当前目录的 git origin 申请项目级 GITHUB_TOKEN
 * ```
 *
 * 纪律（D5）：本命令**禁用 logger**（pino 同步写 fd 1）；stdout 唯一输出通道为单行 token，
 * 失败信息只写 stderr（一行）。命令不注册 startup span、不写文件。
 */
export function registerGithubCommands(
  program: Command,
  deps: RegisterGithubCommandsDeps = {},
): Command {
  program
    .command('github-token')
    .description('Print the project-scoped Github token for the current directory')
    .option('--cwd <dir>', 'Directory whose git origin is used (default: process.cwd())')
    .action(async (options: { cwd?: string }) => {
      const run = deps.runGithubTokenCommand ?? runGithubTokenCommand;
      const code = await run({ ...(options.cwd ? { cwd: options.cwd } : {}) });
      process.exit(code);
    });

  return program;
}
