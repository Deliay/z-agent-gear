import type { ElicitationSchemaProperty } from '../graphql/types';

/** 选项值序列化为可读文本：非字符串（对象/数字等）走 JSON，避免 `[object Object]` */
export function optionLabel(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * 判断字段是否为 ACP question 工具的多选形态（`type: 'array'` + `items.anyOf`）。
 * `items.enum` / `items.oneOf` 数组字段属于通用 MCP 语义，不参与逗号拼接。
 * 注：`anyOf` 与 `enum`/`oneOf` 并存的字段（真实 question 报文不会产生）按保守语义处理——
 * 渲染走 `oneOf → anyOf → enum` 勾选组，但**不**参与拼接，提交保持数组。
 */
export function isMultiSelectAnyOf(prop: ElicitationSchemaProperty): boolean {
  return prop.type === 'array' && Boolean(prop.items?.anyOf) && !prop.items?.enum && !prop.items?.oneOf;
}

/**
 * 构造提交载荷：仅把 `items.anyOf` 多选字段的勾选数组以逗号拼接为字符串回传 ACP
 * （Issue #445）。空数组保持 `[]`（不拼成空串），非数组值原样透传。
 */
export function joinMultiSelectValues(
  values: Record<string, unknown>,
  properties: Record<string, ElicitationSchemaProperty>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...values };
  for (const [name, prop] of Object.entries(properties)) {
    if (!isMultiSelectAnyOf(prop)) continue;
    const value = payload[name];
    if (Array.isArray(value) && value.length > 0) {
      payload[name] = value.map(optionLabel).join(',');
    }
  }
  return payload;
}
