import { CloudWorkload } from '../models/cloud-workload.js';
import {
  HARNESS_OPENCODE_INIT_SCRIPT,
  HARNESS_OPENCODE_INIT_SCRIPT_V1,
} from './006-preset-harness-opencode.js';
import {
  HARNESS_DEEPSEEK_INIT_SCRIPT,
  HARNESS_DEEPSEEK_INIT_SCRIPT_V1,
} from './010-preset-harness-deepseek.js';

/**
 * 011-refresh-harness-prepare-scope：把存量（管理员未定制过的）harness 预置工作负载脚本中
 * 裸 `agent-gear harness prepare` 刷新为按类型限定的调用（v2）。
 *
 * 背景：agent-gear 2.9.0 起 `harness prepare` 对 `ZAG_HARNESS_TYPES` 全部选中类型做 CLI 硬校验；
 * 多 harness 主机上各预置脚本**顺序执行**，先执行的脚本调用裸 prepare 时，排在其后的类型 CLI
 * 尚未安装（如 deepseek 脚本先跑、opencode 未装），硬校验 ENOENT 误失败并触发必须项强制注销。
 * v2 以 `ZAG_HARNESS_TYPES=<本类型>` 前缀限定 prepare 只校验/写入本类型。
 *
 * 刷新口径（同 002-refresh-docker-preset-script）：
 * - `initScript === V2` 直接跳过（已刷新）；`=== V1` 才刷新；其余视为管理员定制，告警且不覆盖；
 * - 预置项不存在时跳过（由 006/010 各自创建，本迁移只负责存量刷新）。
 *
 * 迁移随启动自动执行、失败不阻断（沿用 `admin_migrations` runner 语义）。
 */
export const name = '011-refresh-harness-prepare-scope';

const REFRESHES: Array<{ presetKey: string; v1: string; v2: string }> = [
  {
    presetKey: 'harness-opencode',
    v1: HARNESS_OPENCODE_INIT_SCRIPT_V1,
    v2: HARNESS_OPENCODE_INIT_SCRIPT,
  },
  {
    presetKey: 'harness-deepseek-harness',
    v1: HARNESS_DEEPSEEK_INIT_SCRIPT_V1,
    v2: HARNESS_DEEPSEEK_INIT_SCRIPT,
  },
];

export async function run(): Promise<void> {
  for (const { presetKey, v1, v2 } of REFRESHES) {
    const wl = await CloudWorkload.findOne({ presetKey });
    if (!wl) {
      console.log(`[Migration 011] preset workload "${presetKey}" not found, skipping`);
      continue;
    }
    const initScript = (wl as { initScript?: string | null }).initScript;
    if (initScript === v2) {
      console.log(`[Migration 011] preset workload "${presetKey}" already refreshed, skipping`);
      continue;
    }
    if (initScript === v1) {
      (wl as { initScript: string }).initScript = v2;
      await (wl as { save: () => Promise<unknown> }).save();
      console.log(
        `[Migration 011] preset workload "${presetKey}" init script refreshed (scoped harness prepare)`,
      );
      continue;
    }
    console.warn(
      `[Migration 011] preset workload "${presetKey}" init script modified by admin, skipping`,
    );
  }
}
