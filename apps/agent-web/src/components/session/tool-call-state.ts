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
    case 'edit': return '编辑';
    case 'execute': return '命令';
    case 'delete': return '删除';
    case 'move': return '移动';
    case 'search': return '搜索';
    case 'think': return '思考';
    case 'read': return '读取';
    case 'fetch': return '抓取';
    case 'switch_mode': return '切换模式';
    case 'other': return '工具调用';
    default: return kind || '工具调用';
  }
}

export function toolCallStatusLabel(status?: string): string {
  switch (status) {
    case 'pending': return '等待中';
    case 'in_progress': return '执行中';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    default: return status || '执行中';
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

/** 标题口径：创建时与完成后同一条计算路径，避免「完成后退化为 工具调用：other」 */
export function toolCallTitle(toolCall: MergedToolCall): string {
  if (toolCall.title) return toolCall.title;
  if (toolCall.name) return toolCall.name;
  if (toolCall.kind) return kindLabel(toolCall.kind);
  return '工具调用';
}

/**
 * 卡片头部标题：仅在标题不是通用兜底词时加 `工具调用：` 前缀，
 * 避免创建事件缺失时出现「工具调用：工具调用」（R-3）。
 */
export function toolCallHeaderTitle(toolCall: MergedToolCall): string {
  const title = toolCallTitle(toolCall);
  return title === '工具调用' ? title : `工具调用：${title}`;
}

/** 状态 → AcpCard 语义色（pending 为等待态弱化样式） */
export function toolCallColor(status?: string): 'active' | 'completed' | 'failed' | 'pending' {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'pending') return 'pending';
  return 'active';
}
