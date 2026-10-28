import type { SessionUpdate } from '@agentclientprotocol/sdk';

export interface AcpMessage {
  id: string;
  sessionId: string;
  messageId?: string | null;
  direction: string;
  type: string;
  content: string | Record<string, unknown>;
  metadata: string | null;
  createdAt: string;
}

export interface MessageGroup {
  type: 'user_message' | 'agent_message' | 'thought' | 'plan' | 'tool_call' | 'available_commands' | 'usage' | 'config_option_update' | 'current_mode_update' | 'sub_agent' | 'read' | 'fetch' | 'unknown';
  messages: AcpMessage[];
  parsed: SessionUpdate | null;
  messageId: string | null;
}

export function parseSessionUpdate(content: string | Record<string, unknown>): SessionUpdate | null {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content) as SessionUpdate;
    } catch {
      return null;
    }
  }
  return content as unknown as SessionUpdate;
}

/**
 * 安全读取 rawInput 对象：Agent 端产出的 rawInput 属不可信输入，
 * 畸形 JSON / `'null'` / 标量不得让消息列表渲染崩溃（R-5）。
 */
function readRawInputObject(rawInput: unknown): Record<string, unknown> | null {
  if (typeof rawInput === 'string') {
    try {
      const parsed = JSON.parse(rawInput) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  if (rawInput && typeof rawInput === 'object') {
    return rawInput as Record<string, unknown>;
  }
  return null;
}

export function groupMessages(messages: AcpMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  const toolCallGroupMap = new Map<string, number>(); // toolCallId -> group index
  const thoughtGroupMap = new Map<string, number>();  // messageId -> group index
  const agentMessageGroupMap = new Map<string, number>(); // messageId -> group index

  for (const message of messages) {
    const parsed = parseSessionUpdate(message.content);
    const sessionUpdateType = parsed?.sessionUpdate;
    const raw = parsed as Record<string, unknown> | null;
    const chunkMessageId = raw?.messageId as string | undefined;
    const toolCallId = raw?.toolCallId as string | undefined;

    let groupType: MessageGroup['type'];

    if (sessionUpdateType === 'user_message_chunk') {
      groupType = 'user_message';
    } else if (sessionUpdateType === 'agent_message_chunk') {
      groupType = 'agent_message';
    } else if (sessionUpdateType === 'agent_thought_chunk') {
      groupType = 'thought';
    } else if (sessionUpdateType === 'tool_call' || sessionUpdateType === 'tool_call_update') {
      const p = parsed as Record<string, unknown>;
      const kind = p.kind as string | undefined;
      const rawInput = p.rawInput;
      if (kind === 'read') {
        groupType = 'read';
      } else if (kind === 'fetch') {
        groupType = 'fetch';
      } else if (kind === 'other' && rawInput) {
        const rawInputObj = readRawInputObject(rawInput);
        if (rawInputObj?.subagent_type) {
          groupType = 'sub_agent';
        } else {
          groupType = 'tool_call';
        }
      } else {
        groupType = 'tool_call';
      }
    } else if (sessionUpdateType === 'plan') {
      groupType = 'plan';
    } else if (sessionUpdateType === 'available_commands_update') {
      groupType = 'available_commands';
    } else if (sessionUpdateType === 'usage_update') {
      groupType = 'usage';
    } else if (sessionUpdateType === 'config_option_update') {
      groupType = 'config_option_update';
    } else if (sessionUpdateType === 'current_mode_update') {
      groupType = 'current_mode_update';
    } else {
      // For 'other' kind, check rawInput for subagent_type, kind=read, kind=fetch
      if (parsed) {
        const p = parsed as Record<string, unknown>;
        const kind = p.kind as string | undefined;
        const rawInput = p.rawInput;
        if (kind === 'read') {
          groupType = 'read';
        } else if (kind === 'fetch') {
          groupType = 'fetch';
        } else if (kind === 'other' && readRawInputObject(rawInput)?.subagent_type) {
          groupType = 'sub_agent';
        } else {
          groupType = 'unknown';
        }
      } else {
        groupType = 'unknown';
      }
    }

    let groupIndex: number;

    if ((groupType === 'tool_call' || groupType === 'sub_agent' || groupType === 'read' || groupType === 'fetch') && toolCallId) {
      // Tool calls and specialized types: group by toolCallId across the entire message list
      if (toolCallGroupMap.has(toolCallId)) {
        groupIndex = toolCallGroupMap.get(toolCallId)!;
        // Upgrade group type if the new message has a more specific type
        const existing = groups[groupIndex];
        if (existing.type === 'tool_call' && groupType !== 'tool_call') {
          existing.type = groupType;
        }
      } else {
        groupIndex = groups.length;
        toolCallGroupMap.set(toolCallId, groupIndex);
        groups.push({ type: groupType, messages: [], parsed, messageId: null });
      }
    } else if (groupType === 'thought' && chunkMessageId) {
      // Thought chunks: group by messageId across the entire list
      if (thoughtGroupMap.has(chunkMessageId)) {
        groupIndex = thoughtGroupMap.get(chunkMessageId)!;
      } else {
        groupIndex = groups.length;
        thoughtGroupMap.set(chunkMessageId, groupIndex);
        groups.push({ type: groupType, messages: [], parsed, messageId: chunkMessageId });
      }
    } else if (groupType === 'agent_message' && chunkMessageId) {
      // Agent message chunks with messageId: group by messageId across the entire list
      if (agentMessageGroupMap.has(chunkMessageId)) {
        groupIndex = agentMessageGroupMap.get(chunkMessageId)!;
      } else {
        groupIndex = groups.length;
        agentMessageGroupMap.set(chunkMessageId, groupIndex);
        groups.push({ type: groupType, messages: [], parsed, messageId: chunkMessageId });
      }
    } else if (groupType === 'user_message') {
      // Bug fix: each user message should be its own group, never merge consecutive
      groupIndex = groups.length;
      groups.push({ type: groupType, messages: [], parsed, messageId: null });
    } else {
      // Consecutive grouping for all other types (agent_message, available_commands, usage, etc.)
      const lastIndex = groups.length - 1;
      if (lastIndex >= 0 && groups[lastIndex].type === groupType) {
        groupIndex = lastIndex;
      } else {
        groupIndex = groups.length;
        groups.push({ type: groupType, messages: [], parsed, messageId: null });
      }
    }

    groups[groupIndex].messages.push(message);
  }

  return groups;
}
