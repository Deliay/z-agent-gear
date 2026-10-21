import { execFile } from 'node:child_process';

/** 一次外部命令执行结果（stdout/stderr 均为完整文本）。 */
export interface CommandResult {
  stdout: string;
  stderr: string;
}

/** 可注入的命令执行器（测试使用；生产走 `execFile`）。 */
export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

/** `opencode --version` 硬校验失败。 */
export class OpencodeCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpencodeCliError';
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

const defaultRunner: CommandRunner = (command, args) =>
  new Promise<CommandResult>((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });

/** 从版本输出中取第一行非空文本（去掉前后空白与可能的 `v` 前缀）。 */
export function extractVersion(stdout: string, stderr = ''): string | undefined {
  const line = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  if (!line) return undefined;
  return line.replace(/^v/i, '');
}

/**
 * `opencode --version` 硬校验（`opencode -v` 仅作旧版 CLI 的兼容探测）。
 *
 * 失败时抛 {@link OpencodeCliError}，消息包含「版本校验」提示与命令级错误摘要
 * （不包含任何 env/secret）。调用方（init 脚本 / `harness prepare`）必须以非零退出。
 */
export async function verifyOpencodeCli(runner: CommandRunner = defaultRunner): Promise<string> {
  const failures: string[] = [];

  try {
    const result = await runner('opencode', ['--version']);
    const version = extractVersion(result.stdout, result.stderr);
    if (version) return version;
    failures.push('`opencode --version` returned no version output');
  } catch (error) {
    failures.push(`\`opencode --version\` failed: ${(error as Error).message}`);
  }

  // 兼容旧版 CLI：仅当 `--version` 不可用时探测 `-v`。
  try {
    const result = await runner('opencode', ['-v']);
    const version = extractVersion(result.stdout, result.stderr);
    if (version) return version;
    failures.push('`opencode -v` returned no version output');
  } catch (error) {
    failures.push(`\`opencode -v\` failed: ${(error as Error).message}`);
  }

  throw new OpencodeCliError(
    `OpenCode CLI version check failed; OpenCode is required by the harness workload (${failures.join('; ')})`,
  );
}
