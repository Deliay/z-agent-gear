import type { ElicitationRequestedSchema } from '../graphql/types';

/** 选项值序列化为可读文本：非字符串（对象/数字等）走 JSON，避免 `[object Object]` */
export function optionLabel(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

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
 * 提交值归一：数组字段（ACP question 工具多选题为 `type:'array'` + `items.anyOf`）
 * 必须保持字符串数组回传。历史实现曾按 Issue #445 以逗号拼接为字符串，但 OpenCode
 * 的 question 工具会按 schema 校验表单回填，字符串会导致 form.reply 失败并被取消，
 * 最终映射为 "The user dismissed this question"（Issue #511）。
 */
export function collectElicitationValues(
  values: Record<string, unknown>,
): Record<string, unknown> {
  return { ...values };
}
