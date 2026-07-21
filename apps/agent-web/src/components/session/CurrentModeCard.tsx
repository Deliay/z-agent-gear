interface AcpMessage {
  id: string;
  sessionId: string;
  direction: string;
  type: string;
  content: string | Record<string, unknown>;
  metadata: string | null;
  createdAt: string;
}

interface CurrentModeCardProps {
  messages: AcpMessage[];
}

export default function CurrentModeCard({ messages }: CurrentModeCardProps) {
  if (messages.length === 0) return null;

  const raw = messages[messages.length - 1].content;
  let parsed: { modeId?: string } | null = null;
  if (typeof raw === 'object') {
    parsed = raw as { modeId?: string };
  } else {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (!parsed?.modeId) return null;

  return (
    <div className="w-full">
      <div className="rounded-lg border border-accent bg-accent/50 px-4 py-2 text-sm text-accent-foreground">
        <span className="font-medium">模式已切换为：</span>{' '}
        <span className="font-mono">{parsed.modeId}</span>
      </div>
    </div>
  );
}
