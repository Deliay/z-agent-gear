interface AcpMessage {
  id: string;
  sessionId: string;
  direction: string;
  type: string;
  content: string;
  metadata: string | null;
  createdAt: string;
}

interface MessageItemProps {
  message: AcpMessage;
}

export default function MessageItem({ message }: MessageItemProps) {
  const isUser = message.direction === 'input';

  const getMessageStyle = (type: string) => {
    switch (type) {
      case 'text':
        return isUser
          ? 'bg-blue-600 text-white'
          : 'bg-white text-gray-900 border border-gray-200';
      case 'tool_call':
        return 'bg-purple-100 text-purple-900 border border-purple-200';
      case 'tool_result':
        return 'bg-green-100 text-green-900 border border-green-200';
      case 'plan':
        return 'bg-yellow-100 text-yellow-900 border border-yellow-200';
      case 'error':
        return 'bg-red-100 text-red-900 border border-red-200';
      default:
        return 'bg-gray-100 text-gray-900 border border-gray-200';
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'tool_call':
        return 'Tool Call';
      case 'tool_result':
        return 'Tool Result';
      case 'plan':
        return 'Plan';
      case 'error':
        return 'Error';
      default:
        return null;
    }
  };

  const typeLabel = getTypeLabel(message.type);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[70%] rounded-lg px-4 py-2 ${getMessageStyle(message.type)}`}>
        {typeLabel && (
          <div className="mb-1 text-xs font-medium opacity-75">{typeLabel}</div>
        )}
        <div className="whitespace-pre-wrap">{message.content}</div>
        <div className={`mt-1 text-xs ${isUser ? 'text-blue-200' : 'text-gray-500'}`}>
          {new Date(message.createdAt).toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}