import { useState } from 'react';
import type { ContentBlock, ToolCallContent } from '@agentclientprotocol/sdk';
import MarkdownContent from './MarkdownContent';
import DiffView from './DiffView';
import TerminalOutput from './TerminalOutput';

function ImageBlock({ data, mimeType }: { data: string; mimeType?: string }) {
  const [failed, setFailed] = useState(false);
  // 与 MessageItem 图片特例同口径：data:/http(s): 直接作为 src，其余按 base64 拼接
  const src = data.startsWith('data:') || data.startsWith('http://') || data.startsWith('https://')
    ? data
    : `data:${mimeType || 'image/png'};base64,${data}`;

  if (failed) {
    return (
      <div className="rounded border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
        图片加载失败
      </div>
    );
  }

  return (
    <img
      src={src}
      alt="工具产出图片"
      className="max-h-64 rounded"
      onError={() => setFailed(true)}
    />
  );
}

function AudioBlock({ data, mimeType }: { data: string; mimeType?: string }) {
  const src = data.startsWith('data:') ? data : `data:${mimeType || 'audio/mpeg'};base64,${data}`;
  return <audio controls src={src} className="w-full" />;
}

function ResourceBlock({ block }: { block: Extract<ContentBlock, { type: 'resource' }> }) {
  const resource = block.resource;
  if (resource && 'text' in resource && typeof resource.text === 'string') {
    return <MarkdownContent content={resource.text} />;
  }
  const uri = resource && 'uri' in resource ? String(resource.uri) : '';
  return (
    <div className="rounded border border-border bg-muted px-3 py-2 text-xs text-muted-foreground break-all">
      嵌入资源：{uri || '未知资源'}（二进制内容未内嵌）
    </div>
  );
}

export function ContentBlockView({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case 'text':
      return (
        <div className="prose prose-sm max-w-none text-foreground">
          <MarkdownContent content={block.text} />
        </div>
      );
    case 'image':
      return <ImageBlock data={block.data} mimeType={block.mimeType} />;
    case 'audio':
      return <AudioBlock data={block.data} mimeType={block.mimeType} />;
    case 'resource_link':
      return (
        <a
          href={block.uri}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-0 items-center gap-2 rounded border border-border bg-background px-3 py-2 text-sm text-primary underline hover:text-primary/80"
        >
          <span className="min-w-0 break-all">{block.title || block.name || block.uri}</span>
        </a>
      );
    case 'resource':
      return <ResourceBlock block={block} />;
    default: {
      const unknown = block as { type?: string };
      return (
        <div className="rounded border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          暂不支持的内容类型：{unknown.type || 'unknown'}
        </div>
      );
    }
  }
}

function ToolCallContentItem({ item }: { item: ToolCallContent }) {
  if (item.type === 'content') {
    return <ContentBlockView block={item.content} />;
  }
  if (item.type === 'diff') {
    return <DiffView oldText={item.oldText} newText={item.newText} filePath={item.path} />;
  }
  if (item.type === 'terminal') {
    const output = (item as { output?: unknown }).output;
    if (typeof output === 'string' && output) {
      return <TerminalOutput output={output} />;
    }
    return (
      <div className="text-sm italic text-muted-foreground" data-testid="terminal-placeholder">
        Terminal: {item.terminalId}
      </div>
    );
  }
  return (
    <div className="rounded border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
      暂不支持的工具内容类型：{(item as { type?: string }).type || 'unknown'}
    </div>
  );
}

/** 工具调用产出内容全类型渲染：text/image/audio/resource_link/resource/diff/terminal */
export default function ContentBlockRenderer({ content }: { content: ToolCallContent[] }) {
  return (
    <div className="space-y-2" data-testid="content-block-renderer">
      {content.map((item, index) => (
        <ToolCallContentItem key={index} item={item} />
      ))}
    </div>
  );
}
