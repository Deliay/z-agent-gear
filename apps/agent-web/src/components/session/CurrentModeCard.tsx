interface AcpMessage {
  id: string;
  sessionId: string;
  direction: string;
  type: string;
  content: string;
  metadata: string | null;
  createdAt: string;
}

interface CurrentModeCardProps {
  messages: AcpMessage[];
}

export default function CurrentModeCard({ messages }: CurrentModeCardProps) {
  if (messages.length === 0) return null;

  const content = messages[messages.length - 1].content;
  let parsed: { modeId?: string } | null = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  if (!parsed?.modeId) return null;

  return (
    <div className="w-full">
      <div className="rounded-lg border border-purple-200 bg-purple-50 px-4 py-2 text-sm text-purple-800">
        <span className="font-medium">Mode changed to:</span>{' '}
        <span className="font-mono">{parsed.modeId}</span>
      </div>
    </div>
  );
}
