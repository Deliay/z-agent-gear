import { CloudWorkload } from '../models/cloud-workload.js';

/**
 * 010-preset-harness-deepseek：写入云电脑 harness 运行环境预置项「DeepSeek Harness（Harness）」。
 *
 * 口径（计划 Phase 2，与 006/009 同构）：
 * - `workloadKind='harness'`、`harnessType='deepseek_harness'`、`isPreset=true`；
 * - `paramSchema=[]`（本期无会话参数）；
 * - 仅 `initScript`（Node/npm 已在 worker 镜像内，无 `dependsOnWorkloadIds`）；
 * - init 固定版本**双包同装**（`@deepseek-ai/dsh` 提供 `dsh` bin，`@deepseek-ai/dsh-acp-app`
 *   是 profile 组合包、无 bin）+ `dsh --version` 硬校验 + 默认工作区 + `agent-gear harness prepare`
 *   注入平台渠道模型（cordis.patch.yml + .credentials.yaml，dsh 侧无登录）；
 * - 已存在（presetKey 或精确 name 命中）则跳过并告警，**不覆盖管理员修改**。
 */
export const name = '010-preset-harness-deepseek';

/** 固定 DeepSeek Harness CLI 版本（`dsh` bin 由 `@deepseek-ai/dsh` 提供）。 */
export const DSH_CLI_VERSION = '0.1.2-alpha.2';

/** 固定 DeepSeek Harness ACP profile 组合包版本（无 bin）。 */
export const DSH_ACP_APP_VERSION = '0.1.2-alpha.2';

export const PRESET_KEY = 'harness-deepseek-harness';
export const PRESET_NAME = 'DeepSeek Harness（Harness）';

export const HARNESS_DEEPSEEK_INIT_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

# 1) 固定版本安装 / 版本收敛（缺失或版本不一致时重装，幂等）
#    实测：@deepseek-ai/dsh-acp-app 是 profile 组合包（无 bin），dsh bin 由 @deepseek-ai/dsh 提供
export DSH_CLI_VERSION="\${DSH_CLI_VERSION:-0.1.2-alpha.2}"
export DSH_ACP_APP_VERSION="\${DSH_ACP_APP_VERSION:-0.1.2-alpha.2}"
installed_version=""
if command -v dsh >/dev/null 2>&1; then
  installed_version="$(dsh --version 2>/dev/null | head -n 1 | awk '{print $NF}')" || installed_version=""
  installed_version="\${installed_version#v}"
fi
if [ "\${installed_version}" != "\${DSH_CLI_VERSION}" ]; then
  echo "Installing DeepSeek Harness \${DSH_CLI_VERSION} + acp-app \${DSH_ACP_APP_VERSION} (installed: \${installed_version:-none})"
  npm install -g "@deepseek-ai/dsh@\${DSH_CLI_VERSION}" "@deepseek-ai/dsh-acp-app@\${DSH_ACP_APP_VERSION}"
fi

# 2) 硬校验：命令不可用或版本不一致均视为失败（安装成功但不可用 = 启动失败）
actual_version="$(dsh --version | head -n 1 | awk '{print $NF}')"
actual_version="\${actual_version#v}"
if [ "\${actual_version}" != "\${DSH_CLI_VERSION}" ]; then
  echo "DeepSeek Harness version mismatch: expected \${DSH_CLI_VERSION}, got \${actual_version:-unknown}" >&2
  exit 1
fi

# 3) 默认工作区 + 平台渠道模型注入（cordis.patch.yml + .credentials.yaml）
mkdir -p "\${ZAG_DEFAULT_WORKSPACE:-/root/workspace}"
agent-gear harness prepare
`;

export async function run(): Promise<void> {
  const byKey = await CloudWorkload.findOne({ presetKey: PRESET_KEY });
  if (byKey) {
    console.warn(
      `[Migration 010] preset workload "${PRESET_KEY}" already exists (by presetKey), skipping`,
    );
    return;
  }
  const byName = await CloudWorkload.findOne({ name: PRESET_NAME });
  if (byName) {
    console.warn(`[Migration 010] workload named "${PRESET_NAME}" already exists, skipping`);
    return;
  }

  await CloudWorkload.create({
    name: PRESET_NAME,
    initScript: HARNESS_DEEPSEEK_INIT_SCRIPT,
    postScript: null,
    paramSchema: [],
    dependsOnWorkloadIds: [],
    presetKey: PRESET_KEY,
    isPreset: true,
    workloadKind: 'harness',
    harnessType: 'deepseek_harness',
  });
  console.log(`[Migration 010] preset workload "${PRESET_KEY}" created`);
}
