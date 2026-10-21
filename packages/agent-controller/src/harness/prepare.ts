import { mkdir } from 'node:fs/promises';
import { readHarnessEnv, type HarnessEnv } from './env.js';
import { verifyOpencodeCli, type CommandRunner } from './opencode-cli.js';
import { writeOpencodeConfig, type WriteOpencodeConfigResult } from './opencode-config.js';

/** `harness prepare` 结果摘要（不含任何 secret）。 */
export interface HarnessPrepareResult {
  opencodeVersion: string;
  env: Pick<HarnessEnv, 'modelBaseUrl' | 'defaultWorkspace'> & { modelCount: number };
  config: WriteOpencodeConfigResult;
}

export interface PrepareHarnessOptions {
  env?: NodeJS.ProcessEnv;
  /** 命令执行器（测试注入）。 */
  runner?: CommandRunner;
  /** 覆盖 OpenCode 配置目录（测试/定制场景）。 */
  configDir?: string;
  /** 创建工作区的实现（测试注入）。 */
  makeDir?: (path: string) => Promise<void>;
}

/**
 * 准备 OpenCode harness 环境（契约/计划 Phase 6）：
 *
 * 1. 校验 harness env（缺失项明确报错）；
 * 2. `opencode --version` 硬校验（不通过即失败）；
 * 3. `mkdir -p ZAG_DEFAULT_WORKSPACE`（幂等）；
 * 4. 写入/合并 `opencode.jsonc` 的 `provider.zag`（权限 0600）。
 *
 * secret 只写入配置文件，不进入日志/错误/返回值。
 */
export async function prepareHarness(
  options: PrepareHarnessOptions = {},
): Promise<HarnessPrepareResult> {
  const env = readHarnessEnv(options.env ?? process.env);
  // init 脚本 export OPENCODE_CLI_VERSION：agent-gear 侧做二次硬校验（C-5，缺省不启用）。
  const expectedOpencodeVersion = (options.env ?? process.env).OPENCODE_CLI_VERSION;
  const opencodeVersion = await verifyOpencodeCli(options.runner, expectedOpencodeVersion);

  const makeDir = options.makeDir ?? ((path: string) => mkdir(path, { recursive: true }).then(() => undefined));
  await makeDir(env.defaultWorkspace);

  const config = await writeOpencodeConfig({
    env,
    configDir: options.configDir,
  });

  return {
    opencodeVersion,
    env: {
      modelBaseUrl: env.modelBaseUrl,
      defaultWorkspace: env.defaultWorkspace,
      modelCount: env.modelIds.length,
    },
    config,
  };
}

/** 输出一行摘要（不含 `ZAG_MODEL_API_KEY` / provider apiKey）。 */
export function formatPrepareSummary(result: HarnessPrepareResult): string {
  const created = result.config.created ? 'created' : 'updated';
  return [
    `OpenCode harness prepared: version=${result.opencodeVersion}`,
    `models=${result.env.modelCount}`,
    `workspace=${result.env.defaultWorkspace}`,
    `config=${result.config.path} (${created})`,
  ].join(' ');
}
