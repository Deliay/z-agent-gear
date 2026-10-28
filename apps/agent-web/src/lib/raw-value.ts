export const RAW_CONTENT_LINE_LIMIT = 500;
/** 单行巨串同样需要上限，避免 1 行超长 JSON 卡死渲染（M-8） */
export const RAW_CONTENT_CHAR_LIMIT = 100_000;

/** 原始输入/输出 JSON 美化，超长截断（行数 + 字符数双上限） */
export function formatRawValue(value: unknown): { text: string; truncated: boolean } {
  let json: string;
  try {
    json = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    json = String(value);
  }
  const lines = json.split('\n');
  let truncated = false;
  let text = json;

  if (lines.length > RAW_CONTENT_LINE_LIMIT) {
    text = lines.slice(0, RAW_CONTENT_LINE_LIMIT).join('\n');
    truncated = true;
  }
  if (text.length > RAW_CONTENT_CHAR_LIMIT) {
    text = text.slice(0, RAW_CONTENT_CHAR_LIMIT);
    truncated = true;
  }

  return { text, truncated };
}
