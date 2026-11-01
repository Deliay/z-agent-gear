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
import { HARNESS_DEEPSEEK_SCRIPT_V3 } from './013-preset-harness-deepseek-header-masq.js';
import { PLAYWRIGHT_SCRIPT_V1 } from './015-preset-playwright.js';
import {
  HARNESS_OPENCODE_SCRIPT_V3,
  HARNESS_KIMI_CODE_SCRIPT_V3,
  HARNESS_DEEPSEEK_SCRIPT_V4,
  PLAYWRIGHT_SCRIPT_V2,
} from './017-workload-pnpm-scripts.js';

const log = logger.child({ component: 'migration/018-pnpm-12-upgrade' });

/**
 * 018-pnpm-12-upgrade：把 017 写入的 pnpm 自举回退块从 pnpm 9.15.9 升级到 pnpm 12.16.1。
 *
 * 背景：
 * - worker 镜像与 entrypoint 改用 pnpm 12.16.1（pnpm 9 在 Node 24 下不可用）；
 * - pnpm 12 的全局 bin 目录从 `$PNPM_HOME` 变为 `$PNPM_HOME/bin`，只前置 `$PNPM_HOME`
 *   会让 `pnpm add -g` 直接报 `ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH`。
 *
 * 口径：
 * - 四条预制工作负载（OpenCode / Kimi Code / DeepSeek Harness / Playwright）的脚本，
 *   若库内文本**字节等于** 017 的输出或任一历史版本，则刷新为「017 输出 + pnpm 12 升级」；
 * - 管理员定制过的脚本告警跳过；已删除的预置项静默跳过不恢复；重跑幂等。
 */
export const name = '018-pnpm-12-upgrade';

/** 新 pnpm 固定版本（与 worker 镜像 / entrypoint 同口径）。 */
export const PNPM_VERSION = '12.16.1';

const OLD_PNPM_VERSION = '9.15.9';
const OLD_PATH_LINE = 'export PATH="$PNPM_HOME:$PATH"';
const NEW_PATH_LINE = 'export PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"';

/** 把 017 脚本里的 pnpm 9 引导块升级到 pnpm 12（含全局 bin 目录变更）。 */
export function upgradePnpmBootstrap(script: string): string {
  return script
    .replaceAll(`pnpm@${OLD_PNPM_VERSION}`, `pnpm@${PNPM_VERSION}`)
    .replaceAll(`Installing pnpm ${OLD_PNPM_VERSION}`, `Installing pnpm ${PNPM_VERSION}`)
    .replaceAll(OLD_PATH_LINE, NEW_PATH_LINE);
}

/** OpenCode V4：V3 + pnpm 12 引导块。 */
export const HARNESS_OPENCODE_SCRIPT_V4 = upgradePnpmBootstrap(HARNESS_OPENCODE_SCRIPT_V3);

/** Kimi Code V4：V3 + pnpm 12 引导块。 */
export const HARNESS_KIMI_CODE_SCRIPT_V4 = upgradePnpmBootstrap(HARNESS_KIMI_CODE_SCRIPT_V3);

/** DeepSeek Harness V5：V4 + pnpm 12 引导块。 */
export const HARNESS_DEEPSEEK_SCRIPT_V5 = upgradePnpmBootstrap(HARNESS_DEEPSEEK_SCRIPT_V4);

/** Playwright V3：V2 + pnpm 12 引导块。 */
export const PLAYWRIGHT_SCRIPT_V3 = upgradePnpmBootstrap(PLAYWRIGHT_SCRIPT_V2);

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
  log.info({ presetKey: t.presetKey }, 'script refreshed (pnpm 12)');
}

export async function run(): Promise<void> {
  await refresh({
    presetKey: 'harness-opencode',
    name: 'OpenCode（Harness）',
    oldScripts: [
      HARNESS_OPENCODE_INIT_SCRIPT,
      HARNESS_OPENCODE_INIT_SCRIPT_V1,
      HARNESS_OPENCODE_SCRIPT_V2,
      HARNESS_OPENCODE_SCRIPT_V3,
    ],
    newScript: HARNESS_OPENCODE_SCRIPT_V4,
  });
  await refresh({
    presetKey: 'harness-kimi-code',
    name: 'Kimi Code（Harness）',
    oldScripts: [
      HARNESS_KIMI_CODE_INIT_SCRIPT,
      HARNESS_KIMI_CODE_SCRIPT_V2,
      HARNESS_KIMI_CODE_SCRIPT_V3,
    ],
    newScript: HARNESS_KIMI_CODE_SCRIPT_V4,
  });
  await refresh({
    presetKey: 'harness-deepseek-harness',
    name: 'DeepSeek Harness（Harness）',
    oldScripts: [
      HARNESS_DEEPSEEK_INIT_SCRIPT_V1,
      HARNESS_DEEPSEEK_INIT_SCRIPT,
      HARNESS_DEEPSEEK_SCRIPT_V2,
      HARNESS_DEEPSEEK_SCRIPT_V3,
      HARNESS_DEEPSEEK_SCRIPT_V4,
    ],
    newScript: HARNESS_DEEPSEEK_SCRIPT_V5,
  });
  await refresh({
    presetKey: 'playwright',
    name: 'Playwright',
    oldScripts: [PLAYWRIGHT_SCRIPT_V1, PLAYWRIGHT_SCRIPT_V2],
    newScript: PLAYWRIGHT_SCRIPT_V3,
  });
}
