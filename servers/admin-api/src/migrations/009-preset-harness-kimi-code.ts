import { CloudWorkload } from '../models/cloud-workload.js';

/**
 * 009-preset-harness-kimi-code：写入云电脑 harness 运行环境预置项「Kimi Code（Harness）」。
 *
 * 口径（计划 Phase 2，与 006 同构）：
 * - `workloadKind='harness'`、`harnessType='kimi_code'`、`isPreset=true`；
 * - `paramSchema=[]`（本期无会话参数）；
 * - 仅 `initScript`（Node/npm 已在 worker 镜像内，无 `dependsOnWorkloadIds`）；
 * - init 只装环境（安装 + 硬校验 + mkdir），**不做登录**、**不注入平台模型配置**
 *   （登录在使用前由 agent-gear 闸门完成）；
 * - 已存在（presetKey 或精确 name 命中）则跳过并告警，**不覆盖管理员修改**。
 */
export const name = '009-preset-harness-kimi-code';

/** 固定 Kimi Code CLI 版本（可用同名 env 覆盖）。 */
export const KIMI_CODE_CLI_VERSION = '2.3.2';

export const PRESET_KEY = 'harness-kimi-code';
export const PRESET_NAME = 'Kimi Code（Harness）';

export const HARNESS_KIMI_CODE_INIT_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

# 1) 固定版本安装 / 版本收敛（缺失或版本不一致时重装，幂等）
export KIMI_CODE_CLI_VERSION="\${KIMI_CODE_CLI_VERSION:-2.3.2}"
installed_version=""
if command -v kimi >/dev/null 2>&1; then
  installed_version="$(kimi --version 2>/dev/null | head -n 1 | awk '{print $NF}')" || installed_version=""
  installed_version="\${installed_version#v}"
fi
if [ "\${installed_version}" != "\${KIMI_CODE_CLI_VERSION}" ]; then
  echo "Installing Kimi Code CLI \${KIMI_CODE_CLI_VERSION} (installed: \${installed_version:-none})"
  npm install -g "@moonshot-ai/kimi-code@\${KIMI_CODE_CLI_VERSION}"
fi

# 2) 硬校验：命令不可用或版本不一致均视为失败（安装成功但不可用 = 启动失败）
actual_version="$(kimi --version | head -n 1 | awk '{print $NF}')"
actual_version="\${actual_version#v}"
if [ "\${actual_version}" != "\${KIMI_CODE_CLI_VERSION}" ]; then
  echo "Kimi Code CLI version mismatch: expected \${KIMI_CODE_CLI_VERSION}, got \${actual_version:-unknown}" >&2
  exit 1
fi

# 3) 默认工作区（本期不注入平台模型配置、不做登录；登录在使用前闸门完成）
mkdir -p "\${ZAG_DEFAULT_WORKSPACE:-/root/workspace}"
`;

export async function run(): Promise<void> {
  const byKey = await CloudWorkload.findOne({ presetKey: PRESET_KEY });
  if (byKey) {
    console.warn(
      `[Migration 009] preset workload "${PRESET_KEY}" already exists (by presetKey), skipping`,
    );
    return;
  }
  const byName = await CloudWorkload.findOne({ name: PRESET_NAME });
  if (byName) {
    console.warn(`[Migration 009] workload named "${PRESET_NAME}" already exists, skipping`);
    return;
  }

  await CloudWorkload.create({
    name: PRESET_NAME,
    initScript: HARNESS_KIMI_CODE_INIT_SCRIPT,
    postScript: null,
    paramSchema: [],
    dependsOnWorkloadIds: [],
    presetKey: PRESET_KEY,
    isPreset: true,
    workloadKind: 'harness',
    harnessType: 'kimi_code',
  });
  console.log(`[Migration 009] preset workload "${PRESET_KEY}" created`);
}
