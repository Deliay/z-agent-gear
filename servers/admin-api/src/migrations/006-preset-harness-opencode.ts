import { CloudWorkload } from '../models/cloud-workload.js';

/**
 * 006-preset-harness-opencode：写入云电脑 harness 运行环境预置项「OpenCode（Harness）」。
 *
 * 口径（计划 Phase 3）：
 * - `workloadKind='harness'`、`harnessType='opencode'`、`isPreset=true`；
 * - `paramSchema=[]`（本期无会话参数，二期会话导入/导出再扩展）；
 * - 仅 `initScript`（Node/npm 已在 worker 镜像内，无 `dependsOnWorkloadIds`）；
 * - 已存在（presetKey 或精确 name 命中）则跳过并告警，**不覆盖管理员修改**。
 */
export const name = '006-preset-harness-opencode';

/** 固定 OpenCode CLI 版本（A14：验收以固定版本为准，可用同名 env 覆盖）。 */
export const OPENCODE_CLI_VERSION = '2.1.1';

export const HARNESS_OPENCODE_INIT_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

# 1) 固定版本安装 / 版本收敛（镜像未预装；缺失或版本不一致时强制重装，保证幂等）
export OPENCODE_CLI_VERSION="\${OPENCODE_CLI_VERSION:-2.1.1}"
installed_version=""
if command -v opencode >/dev/null 2>&1; then
  # 已安装时读取实际版本（去掉可能的 v 前缀）；命令失败按未安装处理
  installed_version="$(opencode --version 2>/dev/null | head -n 1 | awk '{print $NF}')" || installed_version=""
  installed_version="\${installed_version#v}"
fi
if [ "\${installed_version}" != "\${OPENCODE_CLI_VERSION}" ]; then
  echo "Installing OpenCode CLI \${OPENCODE_CLI_VERSION} (installed: \${installed_version:-none})"
  npm install -g "@opencode/cli@\${OPENCODE_CLI_VERSION}"
fi

# 硬校验：命令不可用或版本与固定版本不一致均视为失败
actual_version="$(opencode --version | head -n 1 | awk '{print $NF}')"
actual_version="\${actual_version#v}"
if [ "\${actual_version}" != "\${OPENCODE_CLI_VERSION}" ]; then
  echo "OpenCode CLI version mismatch: expected \${OPENCODE_CLI_VERSION}, got \${actual_version:-unknown}" >&2
  exit 1
fi

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
      `[Migration 006] preset workload "${PRESET_KEY}" already exists (by presetKey), skipping`,
    );
    return;
  }
  const byName = await CloudWorkload.findOne({ name: PRESET_NAME });
  if (byName) {
    console.warn(`[Migration 006] workload named "${PRESET_NAME}" already exists, skipping`);
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
  console.log(`[Migration 006] preset workload "${PRESET_KEY}" created`);
}
