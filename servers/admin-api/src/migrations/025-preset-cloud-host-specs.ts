import { logger } from '../observability/logger.js';
import { CloudBillingCursor } from '../models/cloud-billing-cursor.js';
import { CloudHostSpec } from '../models/cloud-host-spec.js';

const log = logger.child({ component: 'migration/025-preset-cloud-host-specs' });

/**
 * 025-preset-cloud-host-specs：规格预制播种 + 计费游标索引兜底。
 *
 * 幂等口径与预制工作负载一致（`findOne({presetKey})` → `findOne({name})` →
 * 均未命中才插入）：命中即跳过，不覆盖管理员修改、删除不重建。
 *
 * `unlimited-0c0g`（0C 0G 0G）默认开启白名单且名单为空（默认无租户可见）；
 * 其余预制规格 `whitelistEnabled=false`（全部租户可见）。
 */
export const name = '025-preset-cloud-host-specs';

export interface PresetCloudHostSpec {
  presetKey: string;
  name: string;
  cpu: number;
  memoryGi: number;
  ephemeralStorageGi: number;
  whitelistEnabled: boolean;
  allowedTenantIds: string[];
}

export const PRESET_CLOUD_HOST_SPECS: readonly PresetCloudHostSpec[] = [
  {
    presetKey: '8c16g-20g',
    name: '8C 16G 20G',
    cpu: 8,
    memoryGi: 16,
    ephemeralStorageGi: 20,
    whitelistEnabled: false,
    allowedTenantIds: [],
  },
  {
    presetKey: '8c8g-20g',
    name: '8C 8G 20G',
    cpu: 8,
    memoryGi: 8,
    ephemeralStorageGi: 20,
    whitelistEnabled: false,
    allowedTenantIds: [],
  },
  {
    presetKey: '4c8g-20g',
    name: '4C 8G 20G',
    cpu: 4,
    memoryGi: 8,
    ephemeralStorageGi: 20,
    whitelistEnabled: false,
    allowedTenantIds: [],
  },
  {
    presetKey: '2c4g-10g',
    name: '2C 4G 10G',
    cpu: 2,
    memoryGi: 4,
    ephemeralStorageGi: 10,
    whitelistEnabled: false,
    allowedTenantIds: [],
  },
  {
    presetKey: '1c2g-5g',
    name: '1C 2G 5G',
    cpu: 1,
    memoryGi: 2,
    ephemeralStorageGi: 5,
    whitelistEnabled: false,
    allowedTenantIds: [],
  },
  {
    presetKey: 'unlimited-0c0g',
    name: '0C 0G 0G',
    cpu: 0,
    memoryGi: 0,
    ephemeralStorageGi: 0,
    whitelistEnabled: true,
    allowedTenantIds: [],
  },
];

export async function run(): Promise<void> {
  // D2：计费游标索引由模型声明，这里显式建索引兜底（生产 autoIndex=false）。
  await CloudBillingCursor.createIndexes();

  for (const preset of PRESET_CLOUD_HOST_SPECS) {
    const existingByKey = await CloudHostSpec.findOne({ presetKey: preset.presetKey })
      .select({ _id: 1 })
      .lean();
    if (existingByKey) continue;
    const existingByName = await CloudHostSpec.findOne({ name: preset.name })
      .select({ _id: 1 })
      .lean();
    if (existingByName) continue;
    await CloudHostSpec.create({
      ...preset,
      isPreset: true,
    });
    log.info({ presetKey: preset.presetKey, name: preset.name }, 'preset cloud host spec seeded');
  }
}
