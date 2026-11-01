import { logger } from '../observability/logger.js';
import { CloudWorkload } from '../models/cloud-workload.js';
import {
  HARNESS_OPENCODE_INIT_SCRIPT,
  HARNESS_OPENCODE_INIT_SCRIPT_V1,
} from './006-preset-harness-opencode.js';
import { HARNESS_KIMI_CODE_INIT_SCRIPT } from './009-preset-harness-kimi-code.js';
import {
  HARNESS_DEEPSEEK_INIT_SCRIPT,
  HARNESS_DEEPSEEK_INIT_SCRIPT_V1,
} from './010-preset-harness-deepseek.js';
import {
  HARNESS_KIMI_CODE_SCRIPT_V2,
  HARNESS_OPENCODE_SCRIPT_V2,
  HARNESS_DEEPSEEK_SCRIPT_V2,
} from './012-worker-user-scripts.js';
import { HARNESS_DEEPSEEK_SCRIPT_V3, PNPM_VERSION_V4 } from './013-preset-harness-deepseek-header-masq.js';
import { PLAYWRIGHT_SCRIPT_V1 } from './015-preset-playwright.js';

const log = logger.child({ component: 'migration/017-workload-pnpm-scripts' });

/**
 * 017-workload-pnpm-scripts：把四条工作负载预置脚本的全局安装行从 `npm install -g` 切到
 * `pnpm add -g`，并在安装行之前插入统一的「pnpm 缺失自举回退」块。
 *
 * 口径（实现计划 `docs/engineering/plan/20261029-feat-pnpm-workload-and-harness-optional.md`）：
 * - 版本链：OpenCode V2→V3、Kimi Code V2→V3、DeepSeek Harness V3→V4、Playwright V1→V2；
 * - 包名与版本 pin 全部不变；硬校验、幂等锚点、`harness prepare`、`dsh plugin`、
 *   `/etc/profile.d` 注入等其余逻辑逐字不动（新常量由旧常量按已知片段替换派生）；
 * - DeepSeek V4 中既有的局部 pnpm 引导收敛为统一回退块（行为等价）；
 * - 统一回退块同时导出 `PNPM_HOME` 并前置 PATH：新镜像由 entrypoint 预装 pnpm，
 *   存量容器自举安装后 `pnpm add -g` 的全局 bin 才能被后续硬校验命中；
 * - 刷新口径同 011/012/013：按 `presetKey`/精确 `name` 定位，库内文本**字节等于**已知历史版本
 *   才替换；管理员定制告警跳过；已删除的预置项**静默跳过不恢复**；重跑幂等。
 *
 * 迁移随启动自动执行、失败不阻断（沿用 `admin_migrations` runner 语义）。
 */
export const name = '017-workload-pnpm-scripts';

/** pnpm 固定版本（与 entrypoint `PNPM_VERSION` 同口径，沿用 013 `PNPM_VERSION_V4`）。 */
export const PNPM_VERSION = PNPM_VERSION_V4;

/**
 * 统一 pnpm 自举回退块（插在各脚本的安装行之前）。
 *
 * `PNPM_HOME` 与 PATH 前置是存量容器（镜像无 pnpm、entrypoint 未接线）能命中
 * `pnpm add -g` 产物 bin 的前提；新镜像上为幂等无害操作。
 */
const PNPM_BOOTSTRAP = `# 0) pnpm 就绪：新镜像由 entrypoint 预装；存量容器经 npm 自举回退固定版本
if ! command -v pnpm >/dev/null 2>&1; then
  echo "Installing pnpm ${PNPM_VERSION}"
  npm install -g "pnpm@${PNPM_VERSION}"
fi
export PNPM_HOME="\${PNPM_HOME:-$HOME/.local/share/pnpm}"
export PATH="$PNPM_HOME:$PATH"
`;

/** 在脚本首行 `export PATH=` 之后插入统一 pnpm 回退块（其余内容逐字保留）。 */
function withPnpmBootstrap(script: string): string {
  const anchor = 'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"\n';
  if (!script.includes(anchor)) {
    throw new Error('pnpm migration: PATH anchor not found in preset script');
  }
  return script.replace(anchor, `${anchor}\n${PNPM_BOOTSTRAP}`);
}

/** `npm install -g <pkg>` → `pnpm add -g <pkg>`（单点替换，缺失即抛错避免静默漏改）。 */
function toPnpmAdd(script: string, npmInstallLine: string, pnpmAddLine: string): string {
  if (!script.includes(npmInstallLine)) {
    throw new Error(`pnpm migration: install line not found: ${npmInstallLine}`);
  }
  return script.replace(npmInstallLine, pnpmAddLine);
}

/** OpenCode V3：V2 基础上安装行切 pnpm + 统一回退块。 */
export const HARNESS_OPENCODE_SCRIPT_V3 = withPnpmBootstrap(
  toPnpmAdd(
    HARNESS_OPENCODE_SCRIPT_V2,
    '  npm install -g "@opencode/cli@${OPENCODE_CLI_VERSION}"',
    '  pnpm add -g "@opencode/cli@${OPENCODE_CLI_VERSION}"',
  ),
);

/** Kimi Code V3：V2 基础上安装行切 pnpm + 统一回退块。 */
export const HARNESS_KIMI_CODE_SCRIPT_V3 = withPnpmBootstrap(
  toPnpmAdd(
    HARNESS_KIMI_CODE_SCRIPT_V2,
    '  npm install -g "@moonshot-ai/kimi-code@${KIMI_CODE_CLI_VERSION}"',
    '  pnpm add -g "@moonshot-ai/kimi-code@${KIMI_CODE_CLI_VERSION}"',
  ),
);

/**
 * DeepSeek Harness V4：V3 基础上双包安装行切 pnpm + 局部 pnpm 引导收敛为统一回退块。
 * `dsh plugin` 的 profile workspace root 安装校验放开与 `harness prepare` 逐字不动。
 */
export const HARNESS_DEEPSEEK_SCRIPT_V4 = withPnpmBootstrap(
  toPnpmAdd(
    HARNESS_DEEPSEEK_SCRIPT_V3
      .replace(
        `#    - dsh plugin 把参数转发给 pnpm；镜像未预装 pnpm，缺失时固定版本安装\n`,
        `#    - dsh plugin 把参数转发给 pnpm（pnpm 已由入口预装或脚本回退块自举）\n`,
      )
      .replace(
        `if ! command -v pnpm >/dev/null 2>&1; then
  echo "Installing pnpm ${PNPM_VERSION_V4}"
  npm install -g "pnpm@${PNPM_VERSION_V4}"
fi
`,
        '',
      ),
    '  npm install -g "@deepseek-ai/dsh@${DSH_CLI_VERSION}" "@deepseek-ai/dsh-acp-app@${DSH_ACP_APP_VERSION}"',
    '  pnpm add -g "@deepseek-ai/dsh@${DSH_CLI_VERSION}" "@deepseek-ai/dsh-acp-app@${DSH_ACP_APP_VERSION}"',
  ),
);

/** Playwright V2：V1 基础上安装行切 pnpm + 统一回退块（插在 registry 配置之后、安装行之前）。 */
export const PLAYWRIGHT_SCRIPT_V2 = toPnpmAdd(
  PLAYWRIGHT_SCRIPT_V1,
  'npm install -g playwright',
  `${PNPM_BOOTSTRAP}pnpm add -g playwright`,
);

interface MutableWorkload {
  initScript?: string | null;
  markModified?: (path: string) => void;
  save: () => Promise<unknown>;
}

interface Target {
  presetKey: string;
  name: string;
  oldScripts: string[];
  newScript: string;
}

async function findWorkload(presetKey: string, workloadName: string) {
  const byKey = await CloudWorkload.findOne({ presetKey });
  if (byKey) return { doc: byKey, viaName: false };
  const byName = await CloudWorkload.findOne({ name: workloadName });
  return byName ? { doc: byName, viaName: true } : null;
}

async function refresh(t: Target): Promise<void> {
  const found = await findWorkload(t.presetKey, t.name);
  // 管理员已删除的预置项不恢复（迁移只增不改/删除即尊重）
  if (!found) return;
  const doc = found.doc as unknown as MutableWorkload;
  if (found.viaName && !doc.initScript) {
    log.warn({ name: t.name }, 'workload exists without presetKey, skipping');
    return;
  }
  if (doc.initScript === t.newScript) return;
  if (!t.oldScripts.includes(doc.initScript ?? '')) {
    log.warn({ presetKey: t.presetKey }, 'script modified by admin, skipping');
    return;
  }
  doc.initScript = t.newScript;
  doc.markModified?.('initScript');
  await doc.save();
  log.info({ presetKey: t.presetKey }, 'script refreshed (pnpm add -g)');
}

export async function run(): Promise<void> {
  await refresh({
    presetKey: 'harness-opencode',
    name: 'OpenCode（Harness）',
    oldScripts: [
      HARNESS_OPENCODE_INIT_SCRIPT,
      HARNESS_OPENCODE_INIT_SCRIPT_V1,
      HARNESS_OPENCODE_SCRIPT_V2,
    ],
    newScript: HARNESS_OPENCODE_SCRIPT_V3,
  });
  await refresh({
    presetKey: 'harness-kimi-code',
    name: 'Kimi Code（Harness）',
    oldScripts: [HARNESS_KIMI_CODE_INIT_SCRIPT, HARNESS_KIMI_CODE_SCRIPT_V2],
    newScript: HARNESS_KIMI_CODE_SCRIPT_V3,
  });
  await refresh({
    presetKey: 'harness-deepseek-harness',
    name: 'DeepSeek Harness（Harness）',
    oldScripts: [
      HARNESS_DEEPSEEK_INIT_SCRIPT_V1,
      HARNESS_DEEPSEEK_INIT_SCRIPT,
      HARNESS_DEEPSEEK_SCRIPT_V2,
      HARNESS_DEEPSEEK_SCRIPT_V3,
    ],
    newScript: HARNESS_DEEPSEEK_SCRIPT_V4,
  });
  await refresh({
    presetKey: 'playwright',
    name: 'Playwright',
    oldScripts: [PLAYWRIGHT_SCRIPT_V1],
    newScript: PLAYWRIGHT_SCRIPT_V2,
  });
}
