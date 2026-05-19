import type { ContentChunk } from '@agentclientprotocol/sdk';

interface ThoughtBlockProps {
  chunks: ContentChunk[];
  createdAt?: string;
}

export default function ThoughtBlock({ chunks, createdAt }: ThoughtBlockProps) {
  const text = chunks
    .map((chunk) => (chunk.content.type === 'text' ? chunk.content.text : ''))
    .join('');

  if (!text) return null;

  return (
    <div className="flex justify-start">
      <div className="max-w-[70%] rounded-lg bg-gray-200 border border-gray-300 px-4 py-3">
        <div className="mb-2 text-xs font-medium text-gray-500 uppercase tracking-wide">
          Thinking
        </div>
        <div className="font-mono text-sm text-gray-700 whitespace-pre-wrap break-words leading-relaxed">
          {text}
        </div>
        <div className="mt-2 text-xs text-gray-500">
          {createdAt ? new Date(createdAt).toLocaleTimeString() : ''}
        </div>
      </div>
    </div>
  );
}
