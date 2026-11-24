/**
 * 容器规格（Cloud Host Spec）前端预校验与错误映射。
 *
 * 口径与 `contracts/admin-cloud-spec.graphql` 一致（服务端仍是唯一事实源）：
 * - 名称 trim 后 1..64；
 * - 三项均为整数；`0/0/0` 是唯一允许含 0 的组合（不限制），其余三项均须 ≥1；
 * - 上限 cpu ≤ 64、memoryGi ≤ 256、ephemeralStorageGi ≤ 512；
 * - 白名单 ≤ 200 个租户。
 */

export const SPEC_NAME_MAX_LENGTH = 64;
export const SPEC_MAX_CPU = 64;
export const SPEC_MAX_MEMORY_GI = 256;
export const SPEC_MAX_EPHEMERAL_STORAGE_GI = 512;
export const SPEC_WHITELIST_MAX_TENANTS = 200;

/** 表单原始输入（数字以字符串承载，便于就地校验与逐字符键入）。 */
export interface SpecFormValues {
  name: string;
  cpu: string;
  memoryGi: string;
  ephemeralStorageGi: string;
}

export interface SpecFormErrors {
  name?: string;
  resources?: string;
}

/** 三项全 0 = 不限制容器（随时可能被系统销毁）。 */
export function isUnlimitedResources(
  cpu: number,
  memoryGi: number,
  ephemeralStorageGi: number,
): boolean {
  return cpu === 0 && memoryGi === 0 && ephemeralStorageGi === 0;
}

const INTEGER_PATTERN = /^\d+$/;

/** 前端即时校验；返回空对象表示通过。 */
export function validateSpecForm(values: SpecFormValues): SpecFormErrors {
  const errors: SpecFormErrors = {};

  const name = values.name.trim();
  if (!name) {
    errors.name = '名称必填';
  } else if (name.length > SPEC_NAME_MAX_LENGTH) {
    errors.name = `名称最多 ${SPEC_NAME_MAX_LENGTH} 个字符`;
  }

  const rawValues = [values.cpu, values.memoryGi, values.ephemeralStorageGi].map((value) =>
    value.trim(),
  );
  if (rawValues.some((value) => !INTEGER_PATTERN.test(value))) {
    errors.resources = 'CPU、内存、临时存储必须为非负整数';
    return errors;
  }

  const [cpu, memoryGi, ephemeralStorageGi] = rawValues.map(Number);
  if (cpu > SPEC_MAX_CPU) {
    errors.resources = `CPU 不可超过 ${SPEC_MAX_CPU}`;
  } else if (memoryGi > SPEC_MAX_MEMORY_GI) {
    errors.resources = `内存不可超过 ${SPEC_MAX_MEMORY_GI} GiB`;
  } else if (ephemeralStorageGi > SPEC_MAX_EPHEMERAL_STORAGE_GI) {
    errors.resources = `临时存储不可超过 ${SPEC_MAX_EPHEMERAL_STORAGE_GI} GiB`;
  } else if (
    !isUnlimitedResources(cpu, memoryGi, ephemeralStorageGi) &&
    (cpu < 1 || memoryGi < 1 || ephemeralStorageGi < 1)
  ) {
    errors.resources = '除「全 0（不限制）」外，三项都必须大于 0';
  }

  return errors;
}

const SPEC_ERROR_MESSAGES: Record<string, string> = {
  'name is required': '名称必填',
  'name is too long': `名称最多 ${SPEC_NAME_MAX_LENGTH} 个字符`,
  'spec name already exists': '规格名称已存在',
  'invalid spec resources': `资源组合非法：三项须全为 0（不限制）或全部大于 0，且 CPU≤${SPEC_MAX_CPU}、内存≤${SPEC_MAX_MEMORY_GI} GiB、临时存储≤${SPEC_MAX_EPHEMERAL_STORAGE_GI} GiB`,
  'invalid tenant in whitelist': `白名单租户无效（租户不存在或超过 ${SPEC_WHITELIST_MAX_TENANTS} 个）`,
  'spec not found': '规格不存在',
};

/** 服务端错误映射；未命中白名单的错误原样透出（与既有页面一致）。 */
export function mapSpecError(message: string): string {
  return SPEC_ERROR_MESSAGES[message] ?? (message || '保存失败，请重试');
}
