import { CloudWorkload } from '../models/cloud-workload.js';

/**
 * 008-fix-github-workload-prefix：修正 Github 预制项 `targetPath` 的语义与默认值。
 *
 * 口径（实现计划 D4 / 裁决 7）：
 * - 007 已写入的默认值 `/root/workspaces/{repo}` 表示「最终目录」，新语义为「clone 前缀地址」；
 * - 仅当 `targetPath.defaultValue` 仍等于旧值时更新为 `/root/workspace`，并把 label 改为
 *   `Clone 前缀地址`；管理员已自定义（值不匹配）时跳过，**不覆盖**；
 * - 无 github 预制项、`paramSchema` 无 `targetPath` 时静默跳过；重复执行幂等。
 */
export const name = '008-fix-github-workload-prefix';

export const GITHUB_PRESET_KEY = 'github';
export const LEGACY_GITHUB_TARGET_PATH = '/root/workspaces/{repo}';
export const GITHUB_PREFIX_DEFAULT = '/root/workspace';
export const GITHUB_PREFIX_LABEL = 'Clone 前缀地址';

export async function run(): Promise<void> {
  const doc = await CloudWorkload.findOne({ presetKey: GITHUB_PRESET_KEY });
  if (!doc) return;

  const schema = Array.isArray(doc.paramSchema)
    ? (doc.paramSchema as unknown as Array<Record<string, unknown>>)
    : [];
  const field = schema.find((item) => item?.key === 'targetPath');
  if (!field) return;
  if (field.defaultValue !== LEGACY_GITHUB_TARGET_PATH) return;

  field.defaultValue = GITHUB_PREFIX_DEFAULT;
  field.label = GITHUB_PREFIX_LABEL;
  doc.markModified('paramSchema');
  await doc.save();
  console.log(
    `[Migration 008] preset workload "${GITHUB_PRESET_KEY}" targetPath default updated to ${GITHUB_PREFIX_DEFAULT}`,
  );
}
