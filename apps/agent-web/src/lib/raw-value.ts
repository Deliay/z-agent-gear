export const RAW_CONTENT_LINE_LIMIT = 500;

/** 原始输入/输出 JSON 美化，超长截断 */
export function formatRawValue(value: unknown): { text: string; truncated: boolean } {
  let json: string;
  try {
    json = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    json = String(value);
  }
  const lines = json.split('\n');
  if (lines.length > RAW_CONTENT_LINE_LIMIT) {
    return {
      text: lines.slice(0, RAW_CONTENT_LINE_LIMIT).join('\n'),
      truncated: true,
    };
  }
  return { text: json, truncated: false };
}
