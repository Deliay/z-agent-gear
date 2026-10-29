import { CloudWorkload } from '../models/cloud-workload.js';

/**
 * 015-preset-playwright：写入预制工作负载「Playwright」（Issue #342）。
 *
 * 口径（实现计划 `docs/engineering/plan/20261028-feat-playwright-workload.md` v1.1）：
 * - `workloadKind='standard'`、`harnessType=null`、`isPreset=true`、`presetKey='playwright'`；
 * - 仅 Chromium 默认安装（`playwright install chromium`），Firefox / WebKit 按需补装；
 * - 浏览器下载地址参数化（`playwright_download_host`，默认值唯一来源为本文件的参数常量），
 *   安装时把解析后的 `PLAYWRIGHT_DOWNLOAD_HOST` 持久化注入 root 与 worker 用户环境；
 * - 隐式依赖「Node.js」预制项（`presetKey='nodejs'`，精确 `name='Node.js'` 防御回退）；
 * - 已存在（presetKey 或精确 name 命中）则跳过并告警，**不覆盖管理员修改**。
 */
export const name = '015-preset-playwright';

export const PLAYWRIGHT_PRESET_KEY = 'playwright';
export const PLAYWRIGHT_PRESET_NAME = 'Playwright';

interface WorkloadParamDefinition {
  key: string;
  label: string;
  type: 'select' | 'multi_select' | 'text' | 'boolean';
  options: string[];
  defaultValue: unknown;
}

/** 「Playwright」工作负载的浏览器下载地址参数定义（默认值唯一来源）。 */
export const PLAYWRIGHT_DOWNLOAD_HOST_PARAM: WorkloadParamDefinition = {
  key: 'playwright_download_host',
  label: 'Playwright 浏览器下载地址',
  type: 'text',
  options: [],
  defaultValue: 'https://nexus.internal.fffdan.com/repository/playwright-proxy/',
};

/**
 * Playwright 预制工作负载安装脚本 v1（自包含、幂等）。
 *
 * - 前置：Node.js / npm 就绪（由「Node.js」预制工作负载隐式依赖先行安装）；
 * - 幂等锚点：`playwright` 可用且浏览器缓存非空 → `playwright --version` 后 `exit 0`
 *   （锚点判定在下载地址取值之前，已安装但地址为空时直接成功）；
 * - 下载地址取值：显式环境变量 `PLAYWRIGHT_DOWNLOAD_HOST`（最高）> 工作负载参数
 *   `WORKLOAD_PARAM_PLAYWRIGHT_DOWNLOAD_HOST` > 空（`exit 2` + 含地址形态的指引）；
 * - 持久化：`/etc/profile.d/playwright.sh`（经 sudo，登录 shell 全局生效）+ root 与 worker
 *   的 `~/.bashrc`（幂等标记块，先清旧块再追加），后续补装浏览器自动沿用内网代理；
 * - npm 包来源沿用 `NPM_REGISTRY` 约定；默认仅安装 Chromium；
 * - 结尾硬校验 `playwright --version` + `$BROWSERS_CACHE` 下存在 `chromium-*` 目录。
 */
export const PLAYWRIGHT_SCRIPT_V1 = `#!/usr/bin/env bash
set -euo pipefail

# 工作负载以 worker 用户执行；写系统级/ root 级文件经 sudo（同 012 口径）
SUDO=sudo; command -v sudo >/dev/null || SUDO=

# Node.js 就绪检查（「Node.js」预制工作负载为隐式依赖，先行执行）
command -v node >/dev/null 2>&1 || { echo "Node.js 未就绪，Playwright 无法初始化" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm 未就绪，Playwright 无法初始化" >&2; exit 1; }

BROWSERS_CACHE="\${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"

# 已安装幂等分支：工具可用且浏览器已就绪则直接校验成功
if command -v playwright >/dev/null 2>&1 && [ -d "$BROWSERS_CACHE" ] && [ -n "$(ls -A "$BROWSERS_CACHE" 2>/dev/null)" ]; then
  playwright --version
  exit 0
fi

# 浏览器下载地址取值优先级：显式环境变量 PLAYWRIGHT_DOWNLOAD_HOST（最高）
# > 工作负载参数 WORKLOAD_PARAM_PLAYWRIGHT_DOWNLOAD_HOST > 空（需安装时快速失败）
PLAYWRIGHT_DOWNLOAD_HOST="\${PLAYWRIGHT_DOWNLOAD_HOST:-\${WORKLOAD_PARAM_PLAYWRIGHT_DOWNLOAD_HOST:-}}"
if [ -z "$PLAYWRIGHT_DOWNLOAD_HOST" ]; then
  echo "Playwright 浏览器下载地址未设置：请在「Playwright」工作负载参数中填写 playwright_download_host（形如 https://<nexus-host>/repository/playwright-proxy/）后重试" >&2
  exit 2
fi

# 持久化下载地址到用户环境：/etc/profile.d/playwright.sh（登录 shell 全局生效）
# + root/worker 各自 ~/.bashrc（交互 shell 生效），后续按需补装浏览器自动沿用内网代理。
# 采用幂等标记块（# >>> playwright download host >>>），重装/改地址时先清旧块再写新块。
ENV_LINE="export PLAYWRIGHT_DOWNLOAD_HOST=\\"$PLAYWRIGHT_DOWNLOAD_HOST\\""
printf '%s\\n' "$ENV_LINE" | \${SUDO} tee /etc/profile.d/playwright.sh >/dev/null
\${SUDO} chmod 644 /etc/profile.d/playwright.sh
for RC in /root/.bashrc /home/worker/.bashrc; do
  if [ -f "$RC" ] || \${SUDO} test -f "$RC"; then
    \${SUDO} sed -i '/^# >>> playwright download host >>>$/,/^# <<< playwright download host <<<$/{ /^# >>> playwright download host >>>$/d; /^# <<< playwright download host <<<$/d; /export PLAYWRIGHT_DOWNLOAD_HOST=/d; }' "$RC" 2>/dev/null || true
    printf '\\n# >>> playwright download host >>>\\n%s\\n# <<< playwright download host <<<\\n' "$ENV_LINE" | \${SUDO} tee -a "$RC" >/dev/null
  fi
done
export PLAYWRIGHT_DOWNLOAD_HOST="$PLAYWRIGHT_DOWNLOAD_HOST"

# npm 包来源沿用 NPM_REGISTRY 约定（内网 npm 代理）
REGISTRY="\${NPM_REGISTRY:-https://nexus.internal.fffdan.com/repository/npm-proxy/}"
npm config set registry "$REGISTRY"
npm install -g playwright

# 默认仅安装 Chromium（控制体积与耗时）；Firefox/WebKit 按需 playwright install firefox|webkit 补装
PLAYWRIGHT_DOWNLOAD_HOST="$PLAYWRIGHT_DOWNLOAD_HOST" playwright install chromium

# 必须校验成功，避免“安装返回 0 但实际不可用”
playwright --version
ls "$BROWSERS_CACHE" 2>/dev/null | grep -q '^chromium-' || {
  echo "Playwright Chromium 未就绪：$BROWSERS_CACHE 下未找到 chromium-* 目录" >&2
  exit 1
}
`;

export async function run(): Promise<void> {
  const byKey = await CloudWorkload.findOne({ presetKey: PLAYWRIGHT_PRESET_KEY });
  if (byKey) {
    console.warn(
      `[Migration 015] preset workload "${PLAYWRIGHT_PRESET_KEY}" already exists (by presetKey), skipping`,
    );
    return;
  }
  const byName = await CloudWorkload.findOne({ name: PLAYWRIGHT_PRESET_NAME });
  if (byName) {
    console.warn(
      `[Migration 015] workload named "${PLAYWRIGHT_PRESET_NAME}" already exists, skipping`,
    );
    return;
  }

  // Node.js 隐式依赖解析（001 的 findExistingId 未导出，这里按 presetKey + 精确 name 防御回退）
  const nodejs =
    (await CloudWorkload.findOne({ presetKey: 'nodejs' })) ??
    (await CloudWorkload.findOne({ name: 'Node.js' }));
  if (!nodejs) {
    console.warn(
      '[Migration 015] preset workload "nodejs" not found, creating without dependency',
    );
  }

  await CloudWorkload.create({
    name: PLAYWRIGHT_PRESET_NAME,
    initScript: PLAYWRIGHT_SCRIPT_V1,
    postScript: null,
    paramSchema: [PLAYWRIGHT_DOWNLOAD_HOST_PARAM],
    dependsOnWorkloadIds: nodejs ? [nodejs._id] : [],
    presetKey: PLAYWRIGHT_PRESET_KEY,
    isPreset: true,
    workloadKind: 'standard',
    harnessType: null,
  });
  console.log(`[Migration 015] preset workload "${PLAYWRIGHT_PRESET_KEY}" created`);
}
