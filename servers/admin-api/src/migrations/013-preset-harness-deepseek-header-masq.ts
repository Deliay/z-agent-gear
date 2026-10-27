import { CloudWorkload } from '../models/cloud-workload.js';
import {
  HARNESS_DEEPSEEK_INIT_SCRIPT,
  HARNESS_DEEPSEEK_INIT_SCRIPT_V1,
} from './010-preset-harness-deepseek.js';
import { HARNESS_DEEPSEEK_SCRIPT_V2 } from './012-worker-user-scripts.js';

/**
 * 013-preset-harness-deepseek-header-masq：把预置工作负载「DeepSeek Harness（Harness）」的
 * init 脚本刷新为 V4 —— 固定版本升级 `0.1.2-alpha.2 → 0.2.1-rc.2`（dsh-header-masq 插件兼容
 * 下限 `>=0.2.1-rc.2 <0.3.0`）+ 新增会话标识插件安装步骤 `dsh plugin --profile acp add
 * Deliay/dsh-header-masq`（`set -euo pipefail` 下非零退出即启动失败）。
 *
 * 刷新口径（沿用 011/012 的精确匹配矩阵）：
 * - `initScript === V4` 直接跳过；
 * - `∈ [010 V1, 010 V2, 012 V3]` 刷新为 V4（历史落库文本逐字匹配，管理员定制不覆盖）；
 * - 其余文本视为管理员定制：告警且不覆盖；
 * - 预置项缺失时按 V4 创建（与 012 `refresh()` 同构）。
 *
 * 迁移随启动自动执行、失败不阻断（沿用 `admin_migrations` runner 语义）。
 */
export const name = '013-preset-harness-deepseek-header-masq';

/** 新版固定版本（dsh-header-masq 插件兼容下限，见提案附录 A.1）。 */
export const DSH_CLI_VERSION_V4 = '0.2.1-rc.2';

/** 新版固定版本（ACP profile 组合包，与 CLI 同代际）。 */
export const DSH_ACP_APP_VERSION_V4 = '0.2.1-rc.2';

/**
 * pnpm 固定版本：`dsh plugin` 把参数转发给 pnpm（worker 镜像未预装），
 * 9.15.9 为实测通过版本（简写解析 + 重跑幂等）。
 */
export const PNPM_VERSION_V4 = '9.15.9';

export const PRESET_KEY = 'harness-deepseek-harness';

export const PRESET_NAME = 'DeepSeek Harness（Harness）';

/**
 * 脚本 V4：012 V2（内容 V3）基础上两处变更——
 * 固定版本升级 + 插件安装步骤（含 pnpm 引导与 profile workspace root 安装校验放开）。
 */
export const HARNESS_DEEPSEEK_SCRIPT_V3 = `#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

# 1) 固定版本安装 / 版本收敛（缺失或版本不一致时重装，幂等）
#    实测：@deepseek-ai/dsh-acp-app 是 profile 组合包（无 bin），dsh bin 由 @deepseek-ai/dsh 提供
#    0.2.1-rc.2 是 dsh-header-masq 插件的兼容下限（>=0.2.1-rc.2 <0.3.0）
export DSH_CLI_VERSION="\${DSH_CLI_VERSION:-${DSH_CLI_VERSION_V4}}"
export DSH_ACP_APP_VERSION="\${DSH_ACP_APP_VERSION:-${DSH_ACP_APP_VERSION_V4}}"
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

# 3) 会话标识插件安装（dsh-header-masq：模型调用自动携带 x-opencode-session）
#    - dsh plugin 把参数转发给 pnpm；镜像未预装 pnpm，缺失时固定版本安装
#    - profile 目录是 pnpm workspace root，需放开 root 安装校验（否则 ERR_PNPM_ADDING_TO_ROOT）
#    - 依赖 set -euo pipefail：安装失败（如插件来源不可达）即启动失败并展示原因
if ! command -v pnpm >/dev/null 2>&1; then
  echo "Installing pnpm ${PNPM_VERSION_V4}"
  npm install -g "pnpm@${PNPM_VERSION_V4}"
fi
mkdir -p "$HOME/.dsh/profiles/acp"
pnpm_config="$HOME/.dsh/profiles/acp/.npmrc"
if ! grep -qs '^ignore-workspace-root-check=true$' "\${pnpm_config}"; then
  echo 'ignore-workspace-root-check=true' >> "\${pnpm_config}"
fi
dsh plugin --profile acp add Deliay/dsh-header-masq

# 4) 默认工作区 + 平台渠道模型注入（cordis.patch.yml + .credentials.yaml）
#    prepare 必须限定本类型：多 harness 主机上各脚本顺序执行，此时其他类型的 CLI
#    可能尚未安装；裸调用会对 ZAG_HARNESS_TYPES 全部选中类型做 CLI 硬校验而误失败
mkdir -p "\${ZAG_DEFAULT_WORKSPACE:-/home/worker/workspace}"
ZAG_HARNESS_TYPES=deepseek_harness agent-gear harness prepare
`;

interface MutableWorkload {
  initScript?: string | null;
  markModified?: (path: string) => void;
  save: () => Promise<unknown>;
}

async function findWorkload(presetKey: string, workloadName: string) {
  const byKey = await CloudWorkload.findOne({ presetKey });
  if (byKey) return { doc: byKey, viaName: false };
  const byName = await CloudWorkload.findOne({ name: workloadName });
  return byName ? { doc: byName, viaName: true } : null;
}

async function refresh(): Promise<void> {
  const found = await findWorkload(PRESET_KEY, PRESET_NAME);
  if (!found) {
    await CloudWorkload.create({
      name: PRESET_NAME,
      presetKey: PRESET_KEY,
      postScript: null,
      paramSchema: [],
      dependsOnWorkloadIds: [],
      isPreset: true,
      workloadKind: 'harness',
      harnessType: 'deepseek_harness',
      initScript: HARNESS_DEEPSEEK_SCRIPT_V3,
    });
    console.log(`[Migration 013] ${PRESET_KEY} created (v4)`);
    return;
  }
  const doc = found.doc as unknown as MutableWorkload;
  if (found.viaName && !doc.initScript) {
    console.warn(`[Migration 013] ${PRESET_NAME} exists without presetKey, skipping`);
    return;
  }
  if (doc.initScript === HARNESS_DEEPSEEK_SCRIPT_V3) return;
  if (!OLD_SCRIPTS.includes(doc.initScript ?? '')) {
    console.warn(`[Migration 013] ${PRESET_KEY} script modified by admin, skipping`);
    return;
  }
  doc.initScript = HARNESS_DEEPSEEK_SCRIPT_V3;
  doc.markModified?.('initScript');
  await doc.save();
  console.log(`[Migration 013] ${PRESET_KEY} script refreshed (dsh 0.2.1-rc.2 + header-masq plugin)`);
}

/** 未定制过的历史落库文本（010 V1 / 010 V2 / 012 V3）。 */
const OLD_SCRIPTS: readonly string[] = [
  HARNESS_DEEPSEEK_INIT_SCRIPT_V1,
  HARNESS_DEEPSEEK_INIT_SCRIPT,
  HARNESS_DEEPSEEK_SCRIPT_V2,
];

export async function run(): Promise<void> {
  await refresh();
}
