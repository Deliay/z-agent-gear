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
 * agent-gear harness prepare   # 按 ZAG_HARNESS_TYPES 校验 env → CLI 硬校验 → 注入配置
 * ```
 *
 * 注入目标（按 `ZAG_HARNESS_TYPES` 分流；缺省/空 → `opencode`）：
 * - `opencode`：`opencode.jsonc` 的 `providers.zag`；
 * - `deepseek_harness`：`profiles/acp/cordis.patch.yml` + `.credentials.yaml`。
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
    .description('Prepare harness runtime (OpenCode / DeepSeek Harness) for cloud-host containers');

  harness
    .command('prepare')
    .description(
      'Validate harness env, verify CLI and write providers.zag into opencode.jsonc or profiles/acp for dsh',
    )
    .action(async () => {
      try {
        const result = await (deps.prepare ?? prepareHarness)();
        // 摘要为 CLI 结果输出（init 脚本/上游脚本按纯文本解析，R3），不走结构化日志。
        console.log(formatPrepareSummary(result)); // no-console-allow: CLI 用户可见输出（结果摘要）
      } catch (error) {
        const secrets = collectSecretValues(process.env);
        const message = redactSecrets((error as Error).message, secrets);
        // 失败原因为 CLI 结果输出（给使用者的失败结果），不走结构化日志。
        console.error(`harness prepare failed: ${message}`); // no-console-allow: CLI 用户可见输出（失败结果）
        // 非零退出：不直接 process.exit，便于测试断言 exitCode 与已刷新的日志。
        process.exitCode = 1;
      }
    });

  return harness;
}
