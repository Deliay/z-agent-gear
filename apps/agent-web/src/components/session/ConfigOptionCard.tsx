interface AcpMessage {
  id: string;
  sessionId: string;
  direction: string;
  type: string;
  content: string;
  metadata: string | null;
  createdAt: string;
}

interface ConfigOptionCardProps {
  messages: AcpMessage[];
}

export default function ConfigOptionCard({ messages }: ConfigOptionCardProps) {
  if (messages.length === 0) return null;

  const content = messages[messages.length - 1].content;
  let parsed: { configOptions?: Array<{ id: string; name?: string; value?: string; currentValue?: string }> } | null = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  const options = parsed?.configOptions ?? [];
  if (options.length === 0) return null;

  return (
    <div className="w-full">
      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800">
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-blue-600">
          Settings Updated
        </div>
        {options.map((opt) => {
          const value = opt.value ?? opt.currentValue;
          if (!value) return null;
          return (
            <div key={opt.id} className="flex gap-2">
              <span className="font-medium capitalize">{opt.id.replace(/_/g, ' ')}:</span>
              <span className="font-mono">{value}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
