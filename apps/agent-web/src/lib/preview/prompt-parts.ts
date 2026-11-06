/**
 * 提示词片段组装 / 过滤 / 限制 / 草稿序列化（提案 §5.2 实现点 12、裁决 6/8）。
 */

export interface PromptPart {
  id: string;
  type: 'text' | 'image';
  text?: string;
  /** base64（不含 data: 前缀） */
  data?: string;
  mimeType?: string;
  name?: string;
  /** 批注回传来源（UI 徽标展示） */
  origin?: unknown;
}

/** 单图片上限 5MB；片段合计上限 10MB（base64 体积按字符串长度计） */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
/** 草稿序列化阈值：合计 >2MB 不持久化（仅内存） */
export const DRAFT_PERSIST_LIMIT = 2 * 1024 * 1024;

/** 过滤 trim 为空的文本片段 / 无 data 的图片片段（与服务端口径一致） */
export function filterParts(parts: PromptPart[]): PromptPart[] {
  return parts.filter((part) =>
    part.type === 'image'
      ? typeof part.data === 'string' && part.data.length > 0
      : typeof part.text === 'string' && part.text.trim() !== '',
  );
}

/** 合并文本：非空文本片段以 `\n\n` 连接（服务端 content 同口径） */
export function mergeText(parts: PromptPart[]): string {
  return filterParts(parts)
    .filter((part) => part.type === 'text')
    .map((part) => part.text!.trim())
    .join('\n\n');
}

/** base64 去 `data:` 前缀（`data:image/png;base64,xxx` → `xxx`） */
export function stripDataPrefix(data: string): string {
  const index = data.indexOf('base64,');
  return index >= 0 ? data.slice(index + 'base64,'.length) : data;
}

export interface PartSizeCheck {
  ok: boolean;
  reason?: 'image-too-large' | 'total-too-large';
}

/** 体积校验：单图片 ≤5MB、合计 ≤10MB（裁决 8） */
export function checkPartSizes(parts: PromptPart[]): PartSizeCheck {
  let total = 0;
  for (const part of parts) {
    if (part.type !== 'image' || typeof part.data !== 'string') continue;
    const size = part.data.length;
    if (size > MAX_IMAGE_BYTES) return { ok: false, reason: 'image-too-large' };
    total += size;
  }
  if (total > MAX_TOTAL_BYTES) return { ok: false, reason: 'total-too-large' };
  return { ok: true };
}

/** 草稿序列化：合计 >2MB 不持久化返回 null（裁决 6） */
export function serializeDraft(parts: PromptPart[]): string | null {
  const json = JSON.stringify(parts.map(({ origin, ...rest }) => rest));
  if (json.length > DRAFT_PERSIST_LIMIT) return null;
  return json;
}

/** 草稿反序列化（损坏返回空数组） */
export function deserializeDraft(raw: string | null): PromptPart[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PromptPart[]) : [];
  } catch {
    return [];
  }
}

/** 发送组装：`[...parts, ...(trim(input) ? [textPart(input)] : [])]`（裁决 6） */
export function buildSendParts(parts: PromptPart[], input: string): PromptPart[] {
  const kept = filterParts(parts);
  const trimmed = input.trim();
  if (trimmed !== '') {
    kept.push({ id: `text-${Date.now()}`, type: 'text', text: trimmed });
  }
  return kept;
}

let partSeq = 0;
/** 生成片段 id（会话内唯一即可） */
export function nextPartId(prefix = 'part'): string {
  partSeq += 1;
  return `${prefix}-${Date.now()}-${partSeq}`;
}
