import { logger as rootLogger } from '../observability/logger.js';
import {
  HARNESS_CONFIG_TYPES,
  HarnessConfig,
  type HarnessConfigType,
} from '../models/harness-config.js';

const logger = rootLogger.child({ component: 'harness-config' });

/** 默认压缩指令（唯一来源：迁移 023 种子与未配置行的归一值均取此常量）。 */
export const DEFAULT_COMPACT_COMMAND = '/compact';
/** compactCommand trim 后长度上限。 */
export const MAX_COMPACT_COMMAND_LENGTH = 64;
/**
 * 未落库行的 `updatedAt` 稳定占位值（epoch ISO）。
 * 契约要求恒返回字符串供前端展示；用固定值而非 `new Date()` 保证测试可断言、列表渲染稳定。
 */
export const UNSET_UPDATED_AT = new Date(0).toISOString();

export interface HarnessConfigView {
  harnessType: HarnessConfigType;
  compactCommand: string;
  updatedAt: string;
}

interface HarnessConfigDoc {
  harnessType: string;
  compactCommand: string;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

/** 校验并归一 Harness 类型；非法值抛 `invalid harness type`。 */
export function validateHarnessType(harnessType: unknown): HarnessConfigType {
  if (
    typeof harnessType !== 'string' ||
    !(HARNESS_CONFIG_TYPES as readonly string[]).includes(harnessType)
  ) {
    throw new Error('invalid harness type');
  }
  return harnessType as HarnessConfigType;
}

/**
 * 校验压缩指令：trim 后长度 1~64 且以 `/` 开头；返回 trim 后的落库值。
 * 非法一律抛 `invalid compact command`（文案与 `contracts/admin-harness.graphql` 逐字一致）。
 */
export function validateCompactCommand(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (
    value.length < 1 ||
    value.length > MAX_COMPACT_COMMAND_LENGTH ||
    !value.startsWith('/')
  ) {
    throw new Error('invalid compact command');
  }
  return value;
}

function mapDoc(doc: HarnessConfigDoc): HarnessConfigView {
  return {
    harnessType: doc.harnessType as HarnessConfigType,
    compactCommand: doc.compactCommand,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : UNSET_UPDATED_AT,
  };
}

/**
 * Harness 平台配置读写服务（`harnessconfigs` 唯一写方）。
 *
 * - `listConfigs()` 恒返回三种 Harness（读库一次后按类型索引；未配置行以默认 `/compact` 归一）；
 * - `upsertConfig()` 校验 → `findOneAndUpdate` upsert → 返回视图。
 */
export class HarnessConfigService {
  async listConfigs(): Promise<HarnessConfigView[]> {
    const docs = (await HarnessConfig.find({}).lean()) as unknown as HarnessConfigDoc[];
    const byType = new Map<string, HarnessConfigDoc>();
    for (const doc of docs) byType.set(doc.harnessType, doc);
    return HARNESS_CONFIG_TYPES.map((harnessType) => {
      const doc = byType.get(harnessType);
      return doc
        ? mapDoc(doc)
        : {
            harnessType,
            compactCommand: DEFAULT_COMPACT_COMMAND,
            updatedAt: UNSET_UPDATED_AT,
          };
    });
  }

  async upsertConfig(harnessType: unknown, compactCommand: unknown): Promise<HarnessConfigView> {
    const type = validateHarnessType(harnessType);
    const command = validateCompactCommand(compactCommand);

    const doc = (await HarnessConfig.findOneAndUpdate(
      { harnessType: type },
      { $set: { compactCommand: command } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean()) as unknown as HarnessConfigDoc | null;
    if (!doc) throw new Error('harness config not found');

    logger.info({ harnessType: type }, 'harness config upserted');
    return mapDoc(doc);
  }
}

export const harnessConfigService = new HarnessConfigService();
