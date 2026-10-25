import type { Command } from 'commander';
import { collectSecretValues, redactSecrets } from '../workload-executor.js';
import { formatPrepareSummary, prepareHarness, type PrepareHarnessOptions } from '../harness/prepare.js';

export interface RegisterHarnessCommandsDeps {
  prepare?: (options?: PrepareHarnessOptions) => Promise<Awaited<ReturnType<typeof prepareHarness>>>;
}

/**
 * 注册 `agent-gear harness` 命令组。
 *
 * ```
 * agent-gear harness prepare   # 校验 env → opencode --version → 写 opencode.jsonc
 * ```
 *
 * 失败以退出码 1 结束（供 harness 工作负载 `required=true` 触发容器强制注销）；
 * 输出/错误均对 `ZAG_MODEL_API_KEY` 等 secret 脱敏。
 */
export function registerHarnessCommands(
  program: Command,
  deps: RegisterHarnessCommandsDeps = {},
): Command {
  const harness = program
    .command('harness')
    .description('Prepare harness runtime (OpenCode) for cloud-host containers');

  harness
    .command('prepare')
    .description('Validate harness env, verify OpenCode CLI and write providers.zag into opencode.jsonc')
    .action(async () => {
      try {
        const result = await (deps.prepare ?? prepareHarness)();
        console.log(formatPrepareSummary(result));
      } catch (error) {
        const secrets = collectSecretValues(process.env);
        const message = redactSecrets((error as Error).message, secrets);
        console.error(`harness prepare failed: ${message}`);
        // 非零退出：不直接 process.exit，便于测试断言 exitCode 与已刷新的日志。
        process.exitCode = 1;
      }
    });

  return harness;
}
