import { execFile } from 'node:child_process';
import { extractVersion, normalizeCliVersion, type CommandRunner } from './opencode-cli.js';

/** `dsh --version` 硬校验失败。 */
export class DshCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DshCliError';
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** 生产默认执行器：`dsh --version`（预发布段原样返回）。 */
const defaultRunner: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
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

/**
 * `dsh --version` 硬校验（计划 §3 B2）：
 *
 * - 版本归一化与 `verifyOpencodeCli` 完全一致（首个非空行 + 末段 + 去 `v` 前缀），
 *   `0.1.2-alpha.2` 预发布段原样比较（不引入 semver）；
 * - `expectedVersion` 非空时要求严格相等；init 脚本已固定双包版本，agent-gear 侧二次校验；
 * - 只有 `--version`，不做 `-v` 回退（dsh 无该兼容需求）。
 *
 * 失败抛 {@link DshCliError}，消息只包含命令与版本信息，不含任何 env/secret。
 */
export async function verifyDshCli(
  runner: CommandRunner = defaultRunner,
  expectedVersion?: string,
): Promise<string> {
  const failures: string[] = [];

  try {
    const result = await runner('dsh', ['--version']);
    const version = extractVersion(result.stdout, result.stderr);
    if (version) {
      if (expectedVersion && normalizeCliVersion(version) !== normalizeCliVersion(expectedVersion)) {
        throw new DshCliError(
          `DeepSeek Harness CLI version mismatch: expected ${expectedVersion}, got ${version}`,
        );
      }
      return version;
    }
    failures.push('`dsh --version` returned no version output');
  } catch (error) {
    if (error instanceof DshCliError) throw error;
    failures.push(`\`dsh --version\` failed: ${(error as Error).message}`);
  }

  throw new DshCliError(
    `DeepSeek Harness CLI version check failed; dsh is required by the harness workload (${failures.join('; ')})`,
  );
}
