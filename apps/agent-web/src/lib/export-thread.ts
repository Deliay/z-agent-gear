import type { ToolCallContent } from '@agentclientprotocol/sdk';
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

/** 标题/思考嵌入 Markdown 结构前的转义：禁止换行破坏标题、禁止闭合 thinking 块（M-10） */
function sanitizeHeading(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function sanitizeThinking(value: string): string {
  return value.replace(/<(\/?)thinking>/gi, '&lt;$1thinking&gt;');
}

function resourceLinkLabel(uri: unknown, fallback: string): string {
  if (typeof uri === 'string' && uri) return fallback ? `${fallback} (${uri})` : uri;
  return fallback;
}

function toolContentSection(content: ToolCallContent[]): string {
  const lines: string[] = ['', '**结果**', ''];
  let emitted = false;

  for (const item of content) {
    if (item.type === 'content') {
      const block = item.content;
      switch (block.type) {
        case 'text':
          lines.push(block.text);
          emitted = true;
          break;
        case 'image':
          lines.push('（图片内容未导出）');
          emitted = true;
          break;
        case 'audio':
          lines.push('（音频内容未导出）');
          emitted = true;
          break;
        case 'resource_link':
          lines.push(`- 资源链接：${resourceLinkLabel(block.uri, block.title || block.name || '')}`);
          emitted = true;
          break;
        case 'resource': {
          const resource = block.resource;
          if (resource && 'text' in resource && typeof resource.text === 'string') {
            lines.push(resource.text);
          } else {
            const uri = resource && 'uri' in resource ? String(resource.uri) : '';
            lines.push(`- 嵌入资源：${uri || '未知资源'}（二进制内容未导出）`);
          }
          emitted = true;
          break;
        }
        default: {
          const unknown = block as { type?: string };
          lines.push(`- 暂不支持的内容类型：${unknown.type || 'unknown'}`);
          emitted = true;
        }
      }
      lines.push('');
      continue;
    }

    if (item.type === 'diff') {
      if (item.path) lines.push(`**${sanitizeHeading(item.path)}**`);
      lines.push('');
      const oldLines = (item.oldText ?? '').split('\n');
      const newLines = (item.newText ?? '').split('\n');
      lines.push('```diff');
      for (const line of oldLines) lines.push(`-${line}`);
      for (const line of newLines) lines.push(`+${line}`);
      lines.push('```');
      lines.push('');
      emitted = true;
      continue;
    }

    if (item.type === 'terminal') {
      const output = (item as { output?: unknown }).output;
      if (typeof output === 'string' && output) {
        lines.push(fenced('text', output));
        emitted = true;
      } else {
        lines.push(`- Terminal: ${item.terminalId}`);
        emitted = true;
      }
      lines.push('');
      continue;
    }

    const unknown = item as { type?: string };
    lines.push(`- 暂不支持的工具内容类型：${unknown.type || 'unknown'}`);
    lines.push('');
    emitted = true;
  }

  return emitted ? lines.join('\n').trimEnd() : '';
}

function toolSection(messages: ToolCallMessageLike[]): string {
  const merged = mergeToolCallMessages(messages);
  const lines: string[] = [];
  lines.push(`### Tool: ${sanitizeHeading(toolCallTitle(merged)) || 'Tool'}`);
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
  // R-11：content 通道（edit 的 diff、terminal 输出、text 结果等）同样是「结果摘要」的一部分
  if (merged.content && merged.content.length > 0) {
    const contentSummary = toolContentSection(merged.content);
    if (contentSummary) {
      lines.push('');
      lines.push(contentSummary);
    }
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

interface SortedMessage {
  message: ExportMessage;
  index: number;
  time: number | null;
}

/**
 * R-10：把流式分片按 messageId（无 messageId 时按相邻同类）合并为一个 section。
 * 与展示层 `mergeMessageChunks`/`groupMessages` 的合并语义保持一致，避免一条回复被空行切碎。
 */
export function threadToMarkdown(messages: ExportMessage[]): string {
  const sorted: SortedMessage[] = (messages ?? []).map((message, index) => {
    const parsed = message.createdAt ? Date.parse(message.createdAt) : Number.NaN;
    return { message, index, time: Number.isNaN(parsed) ? null : parsed };
  });
  // 比较器保持传递性：两侧均有时间才按时间比较，否则退回原始顺序（M-9）
  sorted.sort((a, b) => {
    if (a.time !== null && b.time !== null && a.time !== b.time) return a.time - b.time;
    return a.index - b.index;
  });

  const sections: ExportSection[] = [];
  const consumedToolIds = new Set<string>();
  const chunkSectionIndex = new Map<string, number>();
  let lastAnonymousKind: 'user' | 'assistant' | 'thinking' | null = null;
  let anonymousCounter = 0;

  const allToolMessages = sorted
    .map(({ message }) => message)
    .filter((message) => {
      const parsed = parseSessionUpdate(message.content) as unknown as Record<string, unknown> | null;
      return parsed?.sessionUpdate === 'tool_call' || parsed?.sessionUpdate === 'tool_call_update';
    });

  const pushSection = (kind: ExportSection['kind'], text: string): number => {
    const index = sections.length;
    sections.push({ kind, order: index, text });
    return index;
  };

  for (const { message } of sorted) {
    const parsed = parseSessionUpdate(message.content) as unknown as Record<string, unknown> | null;
    const updateType = parsed?.sessionUpdate;

    if (updateType === 'tool_call' || updateType === 'tool_call_update') {
      lastAnonymousKind = null;
      const toolCallId = typeof parsed?.toolCallId === 'string' ? parsed.toolCallId : '';
      if (toolCallId) {
        if (consumedToolIds.has(toolCallId)) continue;
        consumedToolIds.add(toolCallId);
        const grouped = allToolMessages.filter((item) => {
          const p = parseSessionUpdate(item.content) as unknown as Record<string, unknown> | null;
          return p?.toolCallId === toolCallId;
        });
        pushSection('tool', toolSection(grouped));
      } else {
        pushSection('tool', toolSection([message]));
      }
      continue;
    }

    if (updateType === 'user_message_chunk' || updateType === 'agent_message_chunk') {
      const kind: 'user' | 'assistant' = updateType === 'user_message_chunk' ? 'user' : 'assistant';
      const content = parsed?.content as { type?: string; text?: string } | undefined;
      if (content?.type === 'image') {
        lastAnonymousKind = null;
        pushSection(kind, '（图片内容未导出）');
        continue;
      }
      const text = contentText(content);
      if (!text) continue;

      const messageId = typeof parsed?.messageId === 'string' ? parsed.messageId : null;
      let key: string;
      if (messageId) {
        lastAnonymousKind = null;
        key = `${kind}:${messageId}`;
      } else if (lastAnonymousKind === kind) {
        key = `anon:${kind}:${anonymousCounter - 1}`;
      } else {
        key = `anon:${kind}:${anonymousCounter}`;
        anonymousCounter += 1;
        lastAnonymousKind = kind;
      }

      const existing = chunkSectionIndex.get(key);
      if (existing !== undefined) {
        sections[existing].text += text;
      } else {
        chunkSectionIndex.set(key, pushSection(kind, text));
      }
      continue;
    }

    if (updateType === 'agent_thought_chunk') {
      const text = contentText(parsed?.content);
      if (!text) continue;

      const messageId = typeof parsed?.messageId === 'string' ? parsed.messageId : null;
      let key: string;
      if (messageId) {
        lastAnonymousKind = null;
        key = `thinking:${messageId}`;
      } else if (lastAnonymousKind === 'thinking') {
        key = `anon:thinking:${anonymousCounter - 1}`;
      } else {
        key = `anon:thinking:${anonymousCounter}`;
        anonymousCounter += 1;
        lastAnonymousKind = 'thinking';
      }

      const existing = chunkSectionIndex.get(key);
      if (existing !== undefined) {
        sections[existing].text += text;
      } else {
        chunkSectionIndex.set(key, pushSection('thinking', text));
      }
      continue;
    }

    // 无 sessionUpdate 的历史纯文本消息
    lastAnonymousKind = null;
    if (!updateType && typeof message.content === 'string' && message.content) {
      pushSection(message.direction === 'input' ? 'user' : 'assistant', message.content);
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
    parts.push(section.kind === 'thinking'
      ? `<thinking>\n${sanitizeThinking(section.text)}\n</thinking>`
      : section.text);
  }

  if (sections.length === 0) {
    parts.push('（空会话）');
  }

  return `${parts.join('\n\n')}\n`;
}

/** 触发浏览器下载（Blob + a[download]），延迟回收 object URL 避免慢机器取消下载（M-11） */
export function downloadThreadMarkdown(filename: string, markdown: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
