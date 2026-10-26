import { mkdir } from 'node:fs/promises';
import { readHarnessEnv, resolvePrepareTypes, type HarnessEnv, type PrepareHarnessType } from './env.js';
import { verifyDshCli } from './dsh-cli.js';
import { writeDshConfig, defaultDshHome, type WriteDshConfigResult } from './dsh-config.js';
import { verifyOpencodeCli, type CommandRunner } from './opencode-cli.js';
import { writeOpencodeConfig, type WriteOpencodeConfigResult } from './opencode-config.js';

/** 逐类型的 prepare 结果（摘要不含任何 secret）。 */
export interface HarnessPrepareItemResult {
  type: PrepareHarnessType;
  ok: boolean;
  /** 实际 CLI 版本（opencode / dsh）。 */
  version: string;
  /** 写入的模型数量。 */
  modelCount: number;
  /** 一行摘要（用于 `harness prepare` 输出）。 */
  summary: string;
  config: WriteOpencodeConfigResult | WriteDshConfigResult;
}

/** `harness prepare` 结果摘要（不含任何 secret）。 */
export interface HarnessPrepareResult {
  env: Pick<HarnessEnv, 'modelBaseUrl' | 'defaultWorkspace'> & {
    modelCount: number;
    types: PrepareHarnessType[];
  };
  items: HarnessPrepareItemResult[];
}

export interface PrepareHarnessOptions {
  env?: NodeJS.ProcessEnv;
  /** 命令执行器（测试注入）。 */
  runner?: CommandRunner;
  /** 覆盖 OpenCode 配置目录（测试/定制场景）。 */
  configDir?: string;
  /** 覆盖 dsh home（测试/定制场景；缺省 `$DSH_HOME` 或 `~/.dsh`）。 */
  dshHome?: string;
  /** 创建工作区的实现（测试注入）。 */
  makeDir?: (path: string) => Promise<void>;
}

function formatOpencodeSummary(
  version: string,
  config: WriteOpencodeConfigResult,
): string {
  return `opencode: version=${version} models=${config.modelCount} config=${config.path} (${config.created ? 'created' : 'updated'})`;
}

function formatDeepseekSummary(
  version: string,
  config: WriteDshConfigResult,
): string {
  return [
    `deepseek_harness: version=${version}`,
    `models=${config.modelCount}`,
    `patch=${config.patchPath} (${config.patchCreated ? 'created' : 'updated'})`,
    `credentials=${config.credentialsPath} (${config.credentialsCreated ? 'created' : 'updated'})`,
  ].join(' ');
}

/**
 * 准备 harness 环境（契约/计划 Phase 4）：
 *
 * 1. 校验 harness env（缺失项明确报错，只执行一次）；
 * 2. 按 `ZAG_HARNESS_TYPES` 分流（缺省/空/全非法 → `['opencode']`）逐类型 CLI 硬校验
 *    （`opencode --version` / `dsh --version`），全部通过前不触碰文件系统；
 * 3. `mkdir -p ZAG_DEFAULT_WORKSPACE`（幂等，只执行一次）；
 * 4. 逐类型写入：`opencode` → 合并 `opencode.jsonc`；`deepseek_harness` → 合并
 *    `cordis.patch.yml` / `.credentials.yaml`。任一类型失败整体抛错，已成功部分不回滚（幂等重跑）。
 *
 * 只对所选类型做 CLI 校验与写入：`deepseek_harness` 单选时不触碰 opencode（反之亦然）。
 * secret 只写入配置文件，不进入日志/错误/返回值。
 */
export async function prepareHarness(
  options: PrepareHarnessOptions = {},
): Promise<HarnessPrepareResult> {
  const sourceEnv = options.env ?? process.env;
  const env = readHarnessEnv(sourceEnv);
  const types = resolvePrepareTypes(sourceEnv);

  const makeDir =
    options.makeDir ?? ((path: string) => mkdir(path, { recursive: true }).then(() => undefined));

  const versions = new Map<PrepareHarnessType, string>();
  for (const type of types) {
    // init 脚本 export OPENCODE_CLI_VERSION / DSH_CLI_VERSION：agent-gear 侧做二次硬校验
    //（opencode C-5 缺省不启用；dsh 预发布段精确比较）。
    versions.set(
      type,
      type === 'opencode'
        ? await verifyOpencodeCli(options.runner, sourceEnv.OPENCODE_CLI_VERSION)
        : await verifyDshCli(options.runner, sourceEnv.DSH_CLI_VERSION),
    );
  }

  await makeDir(env.defaultWorkspace);

  const items: HarnessPrepareItemResult[] = [];
  for (const type of types) {
    const version = versions.get(type)!;
    if (type === 'opencode') {
      const config = await writeOpencodeConfig({ env, configDir: options.configDir });
      items.push({
        type,
        ok: true,
        version,
        modelCount: config.modelCount,
        summary: formatOpencodeSummary(version, config),
        config,
      });
      continue;
    }

    const config = await writeDshConfig({
      env,
      dshHome: options.dshHome ?? defaultDshHome(sourceEnv),
    });
    items.push({
      type,
      ok: true,
      version,
      modelCount: config.modelCount,
      summary: formatDeepseekSummary(version, config),
      config,
    });
  }

  return {
    env: {
      modelBaseUrl: env.modelBaseUrl,
      defaultWorkspace: env.defaultWorkspace,
      modelCount: env.modelIds.length,
      types,
    },
    items,
  };
}

/** 输出摘要（首行汇总，随后逐类型一行；不含 `ZAG_MODEL_API_KEY` / provider apiKey）。 */
export function formatPrepareSummary(result: HarnessPrepareResult): string {
  return [
    `Harness prepared: types=${result.env.types.join(',')} models=${result.env.modelCount} workspace=${result.env.defaultWorkspace}`,
    ...result.items.map((item) => `- ${item.summary}`),
  ].join('\n');
}
