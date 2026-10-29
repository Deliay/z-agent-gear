import type { ToolCallContent, ToolCallLocation } from '@agentclientprotocol/sdk';
import { parseSessionUpdate } from './group-messages';

/** 合并函数只依赖消息的 content 字段，便于导出等场景复用 */
export interface ToolCallMessageLike {
  content: string | Record<string, unknown>;
}

export interface MergedToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status: string;
  name?: string;
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolCallContent[];
}

const MERGED_FIELDS = [
  'title',
  'kind',
  'status',
  'name',
  'locations',
  'rawInput',
  'rawOutput',
  'content',
] as const;

export function kindLabel(kind?: string): string {
  switch (kind) {
    case 'edit': return 'Edit';
    case 'execute': return 'Command';
    case 'delete': return 'Delete';
    case 'move': return 'Move';
    case 'search': return 'Search';
    case 'think': return 'Think';
    case 'read': return 'Read';
    case 'fetch': return 'Fetch';
    case 'switch_mode': return 'Switch Mode';
    case 'other': return 'Tool Call';
    default: return kind || 'Tool Call';
  }
}

/**
 * 将同一 toolCallId 的全部消息合并为单一视图模型。
 *
 * 合并语义对齐 zed `ToolCall.apply_patch` 的三态：
 * - 字段未携带（undefined）→ 保留原值
 * - 字段显式 null → 清除
 * - 字段有值 → 替换
 */
export function mergeToolCallMessages(messages: ToolCallMessageLike[]): MergedToolCall {
  const merged: Record<string, unknown> = {
    toolCallId: '',
    status: 'in_progress',
  };

  for (const message of messages) {
    const parsed = parseSessionUpdate(message.content) as unknown as Record<string, unknown> | null;
    if (!parsed) continue;
    const updateType = parsed.sessionUpdate;
    if (updateType !== 'tool_call' && updateType !== 'tool_call_update') continue;

    if (!merged.toolCallId && typeof parsed.toolCallId === 'string') {
      merged.toolCallId = parsed.toolCallId;
    }

    for (const field of MERGED_FIELDS) {
      if (!(field in parsed)) continue;
      const value = parsed[field];
      if (value === undefined) continue;
      if (value === null) {
        delete merged[field];
      } else {
        merged[field] = value;
      }
    }
  }

  const result = merged as unknown as MergedToolCall;
  if (!result.status) {
    result.status = 'in_progress';
  }
  return result;
}

/** 标题口径：创建时与完成后同一条计算路径，避免「完成后退化为 Tool Call: other」 */
export function toolCallTitle(toolCall: MergedToolCall): string {
  if (toolCall.title) return toolCall.title;
  if (toolCall.name) return toolCall.name;
  if (toolCall.kind) return kindLabel(toolCall.kind);
  return 'Tool Call';
}

/**
 * 卡片头部标题：仅在标题不是通用兜底词时加 `Tool Call: ` 前缀，
 * 避免创建事件缺失时出现「Tool Call: Tool Call」（R-3）。
 */
export function toolCallHeaderTitle(toolCall: MergedToolCall): string {
  const title = toolCallTitle(toolCall);
  return title === 'Tool Call' ? title : `Tool Call: ${title}`;
}

/** 状态 → AcpCard 语义色（pending 为等待态弱化样式） */
export function toolCallColor(status?: string): 'active' | 'completed' | 'failed' | 'pending' {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'pending') return 'pending';
  return 'active';
}
