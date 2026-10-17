// 工作负载参数表单的纯函数与常量（无 React 依赖，便于单测与复用）。
//
// 说明：以下校验均为**前端预校验**，服务端（admin-api）才是唯一事实源；
// 错误文案与契约保持一致，便于把错误定位到具体参数与字段。

import type {
  CloudWorkloadParamFieldData,
  CloudWorkloadParamFieldInputData,
  CloudWorkloadParamType,
  CloudWorkloadParamValue,
} from '@/graphql/types';

/** 参数标识：小写字母开头，仅含小写字母/数字/下划线，长度 1~32（契约级）。 */
export const PARAM_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_PARAMS = 20;
export const MAX_PARAM_LABEL_LENGTH = 64;
export const MAX_PARAM_OPTIONS = 50;
export const MAX_PARAM_OPTION_LENGTH = 100;
export const MAX_PARAM_TEXT_LENGTH = 1024;

export const PARAM_TYPE_OPTIONS: CloudWorkloadParamType[] = [
  'SELECT',
  'MULTI_SELECT',
  'TEXT',
  'BOOLEAN',
];

export type ParamSchemaErrorField = 'key' | 'label' | 'options' | 'defaultValue';

export interface ParamSchemaError {
  /** 参数下标；-1 表示列表级错误（如超上限） */
  index: number;
  field: ParamSchemaErrorField;
  message: string;
}

/** 按类型给出默认值初值（切换类型时重置）。 */
export function defaultValueForType(type: CloudWorkloadParamType): CloudWorkloadParamValue {
  if (type === 'MULTI_SELECT') return [];
  if (type === 'BOOLEAN') return false;
  return '';
}

export function createEmptyParam(): CloudWorkloadParamFieldInputData {
  return { key: '', label: '', type: 'TEXT', options: [], defaultValue: '' };
}

/**
 * 与服务端同口径的参数定义预校验（**仅预校验，服务端仍是唯一事实源**）。
 * 返回按参数下标与字段定位的错误列表。
 */
export function validateParamSchema(
  schema: CloudWorkloadParamFieldInputData[],
): ParamSchemaError[] {
  const errors: ParamSchemaError[] = [];
  if (schema.length > MAX_PARAMS) {
    errors.push({ index: -1, field: 'key', message: `参数最多 ${MAX_PARAMS} 个` });
  }

  const seenKeys = new Set<string>();
  schema.forEach((field, index) => {
    const key = (field.key ?? '').trim();
    if (!key) {
      errors.push({ index, field: 'key', message: '参数标识必填' });
    } else if (!PARAM_KEY_PATTERN.test(key)) {
      errors.push({
        index,
        field: 'key',
        message: '参数标识需以小写字母开头，仅含小写字母/数字/下划线，长度 1~32',
      });
    } else if (seenKeys.has(key)) {
      errors.push({ index, field: 'key', message: '参数标识在工作负载内必须唯一' });
    } else {
      seenKeys.add(key);
    }

    const label = (field.label ?? '').trim();
    if (!label) {
      errors.push({ index, field: 'label', message: '显示名称必填' });
    } else if (label.length > MAX_PARAM_LABEL_LENGTH) {
      errors.push({
        index,
        field: 'label',
        message: `显示名称最多 ${MAX_PARAM_LABEL_LENGTH} 个字符`,
      });
    }

    const isSelect = field.type === 'SELECT' || field.type === 'MULTI_SELECT';
    const options = (field.options ?? []).map((option) => option.trim()).filter(Boolean);
    if (isSelect) {
      if (options.length < 1) {
        errors.push({ index, field: 'options', message: '下拉类型至少需要一个可选项' });
      } else if (options.length > MAX_PARAM_OPTIONS) {
        errors.push({ index, field: 'options', message: `可选项最多 ${MAX_PARAM_OPTIONS} 项` });
      } else {
        const seenOptions = new Set<string>();
        for (const option of options) {
          if (option.length > MAX_PARAM_OPTION_LENGTH) {
            errors.push({
              index,
              field: 'options',
              message: `单个可选项最多 ${MAX_PARAM_OPTION_LENGTH} 个字符`,
            });
            break;
          }
          if (seenOptions.has(option)) {
            errors.push({ index, field: 'options', message: '可选项不能重复' });
            break;
          }
          seenOptions.add(option);
        }
      }
    }

    const value = field.defaultValue;
    if (value === undefined || value === null) {
      errors.push({ index, field: 'defaultValue', message: '默认值必填' });
    } else if (field.type === 'SELECT') {
      if (typeof value !== 'string' || value.length === 0) {
        errors.push({ index, field: 'defaultValue', message: '请选择一个默认值' });
      } else if (!options.includes(value)) {
        errors.push({ index, field: 'defaultValue', message: '默认值必须属于可选项' });
      }
    } else if (field.type === 'MULTI_SELECT') {
      if (!Array.isArray(value)) {
        errors.push({ index, field: 'defaultValue', message: '默认值必须为多选数组' });
      } else if (new Set(value).size !== value.length) {
        errors.push({ index, field: 'defaultValue', message: '默认值不能重复' });
      } else if (value.some((item) => typeof item !== 'string' || !options.includes(item))) {
        errors.push({ index, field: 'defaultValue', message: '默认值必须属于可选项' });
      }
    } else if (field.type === 'TEXT') {
      if (typeof value !== 'string') {
        errors.push({ index, field: 'defaultValue', message: '默认值必须为文本' });
      } else if (value.length > MAX_PARAM_TEXT_LENGTH) {
        errors.push({
          index,
          field: 'defaultValue',
          message: `文本默认值最多 ${MAX_PARAM_TEXT_LENGTH} 个字符`,
        });
      }
    } else if (field.type === 'BOOLEAN') {
      if (typeof value !== 'boolean') {
        errors.push({ index, field: 'defaultValue', message: '默认值必须为布尔值' });
      }
    }
  });

  return errors;
}

/** 归一化为提交入参：非下拉类型 options 归一为 []，字符串去空白、多选去重。 */
export function normalizeParamSchema(
  schema: CloudWorkloadParamFieldInputData[],
): CloudWorkloadParamFieldInputData[] {
  return schema.map((field) => {
    const isSelect = field.type === 'SELECT' || field.type === 'MULTI_SELECT';
    const options = isSelect
      ? (field.options ?? []).map((option) => option.trim()).filter(Boolean)
      : [];
    let defaultValue = field.defaultValue;
    if (field.type === 'MULTI_SELECT' && Array.isArray(defaultValue)) {
      defaultValue = [...new Set(defaultValue)];
    }
    return {
      key: field.key.trim(),
      label: field.label.trim(),
      type: field.type,
      options,
      defaultValue,
    };
  });
}

// ---------- 参数值（启动时填写） ----------

export type WorkloadParamValues = Record<string, CloudWorkloadParamValue>;

export interface ParamValueError {
  key: string;
  message: string;
}

/** 由 paramSchema 生成默认参数（键存在即视为已填写，含 false / 空字符串 / 空数组）。 */
export function buildDefaultParams(schema: CloudWorkloadParamFieldData[]): WorkloadParamValues {
  const params: WorkloadParamValues = {};
  for (const field of schema) {
    params[field.key] = field.defaultValue;
  }
  return params;
}

/** 是否已填写：以「键是否存在」判定，绝不用 truthy（裁决 11）。 */
export function isParamFilled(values: WorkloadParamValues, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(values, key);
}

/** 取值：键存在用填写值，否则回退默认值。 */
export function resolveParamValue(
  field: CloudWorkloadParamFieldData,
  values: WorkloadParamValues,
): CloudWorkloadParamValue {
  return isParamFilled(values, field.key) ? values[field.key] : field.defaultValue;
}

/** 与服务端同口径的参数值预校验（服务端仍强制）。 */
export function validateParamValues(
  schema: CloudWorkloadParamFieldData[],
  values: WorkloadParamValues,
): ParamValueError[] {
  const errors: ParamValueError[] = [];
  for (const field of schema) {
    const value = resolveParamValue(field, values);
    const options = field.options ?? [];
    if (field.type === 'SELECT') {
      if (typeof value !== 'string' || value.length === 0 || !options.includes(value)) {
        errors.push({ key: field.key, message: '默认值/取值必须属于可选项' });
      }
    } else if (field.type === 'MULTI_SELECT') {
      if (!Array.isArray(value)) {
        errors.push({ key: field.key, message: '取值必须为多选数组' });
      } else if (value.some((item) => typeof item !== 'string' || !options.includes(item))) {
        errors.push({ key: field.key, message: '取值必须属于可选项' });
      }
    } else if (field.type === 'TEXT') {
      if (typeof value !== 'string') {
        errors.push({ key: field.key, message: '取值必须为文本' });
      } else if (value.length > MAX_PARAM_TEXT_LENGTH) {
        errors.push({ key: field.key, message: `文本取值最多 ${MAX_PARAM_TEXT_LENGTH} 个字符` });
      }
    } else if (field.type === 'BOOLEAN') {
      if (typeof value !== 'boolean') {
        errors.push({ key: field.key, message: '取值必须为布尔值' });
      }
    }
  }
  return errors;
}

// ---------- 参数快照展示 ----------

/** 参数快照展示：字符串原样、布尔 true/false、多选 JSON 数组字符串。 */
export function formatParamValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null || value === undefined) return '-';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatParams(params: Record<string, unknown> | null | undefined): string {
  const entries = Object.entries(params ?? {});
  if (entries.length === 0) return '-';
  return entries.map(([key, value]) => `${key}: ${formatParamValue(value)}`).join('\n');
}
