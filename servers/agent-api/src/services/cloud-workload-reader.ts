import { CloudWorkload } from '../models/cloud-workload.js';
import type { HarnessType } from '../models/cloud-host.js';

export interface HarnessPreset {
  id: string;
  name: string;
  initScript: string | null;
  postScript: string | null;
  harnessType: HarnessType;
}

const PRESET_KEYS: Record<HarnessType, string> = {
  OPENCODE: 'harness-opencode',
};

const HARNESS_SLUGS: Record<HarnessType, string> = {
  OPENCODE: 'opencode',
};

/**
 * 读取 harness 预制工作负载（只读 `cloudworkloads`）。
 * 缺失时抛 `harness workload preset not found: <slug>`（与契约错误文案一致）。
 */
export class CloudWorkloadReader {
  async findHarnessPreset(type: HarnessType): Promise<HarnessPreset> {
    const presetKey = PRESET_KEYS[type];
    const doc = await CloudWorkload.findOne({
      presetKey,
      workloadKind: 'harness',
      harnessType: HARNESS_SLUGS[type],
    }).lean();
    if (!doc) {
      throw new Error(`harness workload preset not found: ${HARNESS_SLUGS[type]}`);
    }
    return {
      id: String(doc._id),
      name: doc.name,
      initScript: doc.initScript ?? null,
      postScript: doc.postScript ?? null,
      harnessType: type,
    };
  }
}

export function harnessSlug(type: HarnessType): string {
  return HARNESS_SLUGS[type];
}

export const cloudWorkloadReader = new CloudWorkloadReader();
