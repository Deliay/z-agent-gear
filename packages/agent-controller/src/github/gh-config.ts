import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { redactSecrets } from '../workload-executor.js';

/** `gh` 进程启动函数（测试注入；生产使用 `node:child_process.spawn`）。 */
export type GhSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface WriteGhAuthOptions {
  /** 注入 spawn（测试用）；生产缺省使用 `node:child_process.spawn`。 */
  spawn?: GhSpawn;
}

/**
 * 执行一次 `gh` 子命令并收集输出。
 *
 * - `stdin` 只经管道写入（token 绝不进入 argv/env）；
 * - 失败时按 `redactSecrets` 脱敏后再拼接错误，错误信息不含任何 secret；
 * - 每次调用只执行一次，不做重试（避免无限循环）。
 */
function runGh(spawnFn: GhSpawn, args: string[], stdin?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawnFn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      output += chunk.toString();
    });
    child.on('error', (error: Error) => {
      // spawn 级别错误（如 ENOENT）通常不含输出，但仍统一脱敏。
      finish(new Error(`执行 gh ${args.join(' ')} 失败：${redactSecrets(error.message, [stdin ?? ''])}`));
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = redactSecrets(output.trim(), [stdin ?? '']);
      const suffix = signal ? `signal=${signal}` : `退出码 ${code ?? 'null'}`;
      finish(new Error(`gh ${args.join(' ')} 失败（${suffix}）${detail ? `：${detail}` : ''}`));
    });

    // token 只经 stdin 传递，不进入 argv/env。
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    } else {
      child.stdin?.end();
    }
  });
}

/**
 * 将 Github token 写入容器内 `gh` 配置（云主机唯一凭据写入口）。
 *
 * 1. `gh auth login --with-token`：token 经 stdin 传入；
 * 2. `gh auth setup-git`：配置 git credential helper。
 *
 * 任一步失败立即抛错（不重试）；错误信息不含 token。
 */
export async function writeGhAuth(token: string, options: WriteGhAuthOptions = {}): Promise<void> {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Github token 为空');
  }
  const spawnFn = options.spawn ?? (spawn as unknown as GhSpawn);
  await runGh(spawnFn, ['auth', 'login', '--with-token'], token);
  await runGh(spawnFn, ['auth', 'setup-git']);
}
