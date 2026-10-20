import { CloudWorkload } from '../models/cloud-workload.js';

/**
 * 005-preset-harness-opencode：写入云电脑 harness 运行环境预置项「OpenCode（Harness）」。
 *
 * 口径（计划 Phase 3）：
 * - `workloadKind='harness'`、`harnessType='opencode'`、`isPreset=true`；
 * - `paramSchema=[]`（本期无会话参数，二期会话导入/导出再扩展）；
 * - 仅 `initScript`（Node/npm 已在 worker 镜像内，无 `dependsOnWorkloadIds`）；
 * - 已存在（presetKey 或精确 name 命中）则跳过并告警，**不覆盖管理员修改**。
 */
export const name = '005-preset-harness-opencode';

/** 固定 OpenCode CLI 版本（A14：验收以固定版本为准，可用同名 env 覆盖）。 */
export const OPENCODE_CLI_VERSION = '2.1.1';

export const HARNESS_OPENCODE_INIT_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

# 1) 固定版本安装（镜像未预装；仅命令缺失时安装，保证幂等）
OPENCODE_CLI_VERSION="\${OPENCODE_CLI_VERSION:-2.1.1}"
if ! command -v opencode >/dev/null 2>&1; then
  npm install -g "@opencode/cli@\${OPENCODE_CLI_VERSION}"
fi
opencode --version   # 硬校验：安装返回 0 但不可用视为失败

# 2) 默认工作区 + 模型配置注入（opencode.jsonc，custom provider）
mkdir -p "\${ZAG_DEFAULT_WORKSPACE:-/root/workspace}"
agent-gear harness prepare
`;

const PRESET_KEY = 'harness-opencode';
const PRESET_NAME = 'OpenCode（Harness）';

export async function run(): Promise<void> {
  const byKey = await CloudWorkload.findOne({ presetKey: PRESET_KEY });
  if (byKey) {
    console.warn(
      `[Migration 005] preset workload "${PRESET_KEY}" already exists (by presetKey), skipping`,
    );
    return;
  }
  const byName = await CloudWorkload.findOne({ name: PRESET_NAME });
  if (byName) {
    console.warn(`[Migration 005] workload named "${PRESET_NAME}" already exists, skipping`);
    return;
  }

  await CloudWorkload.create({
    name: PRESET_NAME,
    initScript: HARNESS_OPENCODE_INIT_SCRIPT,
    postScript: null,
    paramSchema: [],
    dependsOnWorkloadIds: [],
    presetKey: PRESET_KEY,
    isPreset: true,
    workloadKind: 'harness',
    harnessType: 'opencode',
  });
  console.log(`[Migration 005] preset workload "${PRESET_KEY}" created`);
}
