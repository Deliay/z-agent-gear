import { parseSessionUpdate } from '../components/session/group-messages';
import {
  mergeToolCallMessages,
  toolCallTitle,
  type ToolCallMessageLike,
} from '../components/session/tool-call-state';

export interface ExportMessage {
  direction: string;
  content: string | Record<string, unknown>;
  createdAt?: string;
}

interface ExportSection {
  kind: 'user' | 'assistant' | 'thinking' | 'tool';
  order: number;
  text: string;
}

function fenced(language: string, body: string): string {
  const safe = body.length > 0 ? body : '';
  return `\`\`\`${language}\n${safe}\n\`\`\``;
}

function jsonBlock(value: unknown): string {
  if (value === undefined) return '';
  try {
    return fenced('json', JSON.stringify(value, null, 2));
  } catch {
    return fenced('text', String(value));
  }
}

function toolSection(messages: ToolCallMessageLike[]): string {
  const merged = mergeToolCallMessages(messages);
  const lines: string[] = [];
  lines.push(`### Tool: ${toolCallTitle(merged)}`);
  lines.push('');
  lines.push(`- 状态: ${merged.status || 'in_progress'}`);
  if (merged.kind) lines.push(`- 类型: ${merged.kind}`);
  if (merged.rawInput !== undefined) {
    lines.push('');
    lines.push('**输入**');
    lines.push('');
    lines.push(jsonBlock(merged.rawInput));
  }
  if (merged.rawOutput !== undefined) {
    lines.push('');
    lines.push('**输出**');
    lines.push('');
    lines.push(jsonBlock(merged.rawOutput));
  }
  return lines.join('\n');
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && 'text' in content) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

/**
 * 将会话消息序列导出为结构化 Markdown（参考 zed `to_markdown` 口径）。
 * 纯前端转换：用户 / 助手 / 思考 / 工具调用分节，附时间顺序。
 */
export function threadToMarkdown(messages: ExportMessage[]): string {
  const sorted = [...(messages ?? [])].map((message, index) => ({ message, index })).sort((a, b) => {
    const at = a.message.createdAt ? Date.parse(a.message.createdAt) : NaN;
    const bt = b.message.createdAt ? Date.parse(b.message.createdAt) : NaN;
    if (Number.isNaN(at) || Number.isNaN(bt) || at === bt) return a.index - b.index;
    return at - bt;
  });

  const sections: ExportSection[] = [];
  const consumedToolIds = new Set<string>();

  const allToolMessages = sorted
    .map(({ message }) => message)
    .filter((message) => {
      const parsed = parseSessionUpdate(message.content) as unknown as Record<string, unknown> | null;
      return parsed?.sessionUpdate === 'tool_call' || parsed?.sessionUpdate === 'tool_call_update';
    });

  let order = 0;
  for (const { message } of sorted) {
    const parsed = parseSessionUpdate(message.content) as unknown as Record<string, unknown> | null;
    const updateType = parsed?.sessionUpdate;

    if (updateType === 'tool_call' || updateType === 'tool_call_update') {
      const toolCallId = typeof parsed?.toolCallId === 'string' ? parsed.toolCallId : '';
      if (toolCallId) {
        if (consumedToolIds.has(toolCallId)) continue;
        consumedToolIds.add(toolCallId);
        const grouped = allToolMessages.filter((item) => {
          const p = parseSessionUpdate(item.content) as unknown as Record<string, unknown> | null;
          return p?.toolCallId === toolCallId;
        });
        sections.push({ kind: 'tool', order: order++, text: toolSection(grouped) });
      } else {
        sections.push({ kind: 'tool', order: order++, text: toolSection([message]) });
      }
      continue;
    }

    if (updateType === 'user_message_chunk' || updateType === 'agent_message_chunk') {
      const content = parsed?.content as { type?: string; text?: string } | undefined;
      if (content?.type === 'image') {
        sections.push({
          kind: updateType === 'user_message_chunk' ? 'user' : 'assistant',
          order: order++,
          text: '（图片内容未导出）',
        });
        continue;
      }
      const text = contentText(content);
      if (!text) continue;
      sections.push({
        kind: updateType === 'user_message_chunk' ? 'user' : 'assistant',
        order: order++,
        text,
      });
      continue;
    }

    if (updateType === 'agent_thought_chunk') {
      const text = contentText(parsed?.content);
      if (!text) continue;
      sections.push({
        kind: 'thinking',
        order: order++,
        text: `<thinking>\n${text}\n</thinking>`,
      });
      continue;
    }

    // 无 sessionUpdate 的历史纯文本消息
    if (!updateType && typeof message.content === 'string' && message.content) {
      sections.push({
        kind: message.direction === 'input' ? 'user' : 'assistant',
        order: order++,
        text: message.content,
      });
    }
  }

  const parts: string[] = ['# 会话记录'];
  let currentHead: string | null = null;
  for (const section of sections.sort((a, b) => a.order - b.order)) {
    if (section.kind === 'tool') {
      currentHead = null;
      parts.push(section.text);
      continue;
    }
    const head = section.kind === 'user' ? '## User' : '## Assistant';
    if (head !== currentHead) {
      parts.push(head);
      currentHead = head;
    }
    parts.push(section.text);
  }

  if (sections.length === 0) {
    parts.push('（空会话）');
  }

  return `${parts.join('\n\n')}\n`;
}

/** 触发浏览器下载（Blob + a[download]） */
export function downloadThreadMarkdown(filename: string, markdown: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
