import type { ContentChunk } from '@agentclientprotocol/sdk';
import AcpCard from './AcpCard';

interface ThoughtBlockProps {
  chunks: ContentChunk[];
  createdAt?: string;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

export default function ThoughtBlock({ chunks, createdAt, expanded, onExpandedChange }: ThoughtBlockProps) {
  const text = chunks
    .map((chunk) => (chunk.content.type === 'text' ? chunk.content.text : ''))
    .join('');

  if (!text) return null;

  const summary = text.length > 60 ? text.slice(0, 60) + '...' : text;

  return (
    <AcpCard
      title="Thinking"
      summary={summary}
      defaultCollapsed={true}
      color="gray"
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    >
      <div className="font-mono text-sm text-gray-700 whitespace-pre-wrap break-words leading-relaxed">
        {text}
      </div>
      <div className="mt-2 text-xs text-gray-500">
        {createdAt ? new Date(createdAt).toLocaleTimeString() : ''}
      </div>
    </AcpCard>
  );
}
