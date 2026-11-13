import { joinMultiSelectValues, optionLabel } from './elicitation-multi-select';
import type { ElicitationRequestedSchema, ElicitationSchemaProperty } from '../graphql/types';

/** 从 schema 构建默认值（boolean 默认 false） */
export function buildElicitationDefaults(
  schema: ElicitationRequestedSchema | null | undefined,
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(schema?.properties ?? {})) {
    if (prop.default !== undefined) {
      defaults[name] = prop.default;
    } else if (prop.type === 'boolean') {
      defaults[name] = false;
    }
  }
  return defaults;
}

export function isEmptyElicitationValue(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

export interface UrlParts {
  origin: string;
  host: string;
  rest: string;
}

export function splitUrl(url: string): UrlParts | null {
  try {
    const parsed = new URL(url);
    return {
      origin: `${parsed.protocol}//`,
      host: parsed.host,
      rest: `${parsed.pathname}${parsed.search}${parsed.hash}`,
    };
  } catch {
    return null;
  }
}

/** 必填校验：返回缺失字段名（顺序同 schema.required） */
export function missingRequiredFields(
  schema: ElicitationRequestedSchema | null | undefined,
  values: Record<string, unknown>,
): string[] {
  return (schema?.required ?? []).filter((name) => isEmptyElicitationValue(values[name]));
}

/**
 * 提交值归一：**仅** `type:'array'` + `items.anyOf`（ACP question 工具多选题）
 * 以逗号拼接为字符串回传；`items.enum` / `items.oneOf` 数组仍提交数组。
 */
export function collectElicitationValues(
  values: Record<string, unknown>,
  properties: Record<string, ElicitationSchemaProperty>,
): Record<string, unknown> {
  return joinMultiSelectValues(values, properties);
}

export { optionLabel };
