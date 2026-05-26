import type { SessionUpdate } from '@agentclientprotocol/sdk';
import MarkdownContent from './MarkdownContent';

interface AcpMessage {
  id: string;
  sessionId: string;
  direction: string;
  type: string;
  content: string | Record<string, unknown>;
  metadata: string | null;
  createdAt: string;
}

interface MessageItemProps {
  message: AcpMessage;
}

export default function MessageItem({ message }: MessageItemProps) {
  const isUser = message.direction === 'input';

  const acpUpdate = (() => {
    if (typeof message.content === 'object') return message.content as unknown as SessionUpdate;
    try { return JSON.parse(message.content) as SessionUpdate; } catch { return null; }
  })();

  const displayType = (() => {
    if (!acpUpdate) return message.type;
    switch (acpUpdate.sessionUpdate) {
      case 'agent_message_chunk':
      case 'user_message_chunk':
        return 'text';
      case 'tool_call':
        return 'tool_call';
      case 'tool_call_update':
        return 'tool_call';
      default:
        return message.type;
    }
  })();

  const displayContent: string = (() => {
    if (!acpUpdate) return typeof message.content === 'string' ? message.content : '';
    switch (acpUpdate.sessionUpdate) {
      case 'agent_message_chunk':
      case 'user_message_chunk':
        return acpUpdate.content.type === 'text' ? acpUpdate.content.text : '';
      case 'tool_call':
        return typeof acpUpdate.title === 'string' ? acpUpdate.title : '';
      case 'tool_call_update':
        return acpUpdate.title || '';
      default:
        return typeof message.content === 'string' ? message.content : '';
    }
  })();

  const toolTitle = (() => {
    if (!acpUpdate) return null;
    if (acpUpdate.sessionUpdate === 'tool_call') return acpUpdate.title;
    if (acpUpdate.sessionUpdate === 'tool_call_update') return acpUpdate.title;
    return null;
  })();

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
      case 'error':
        return 'bg-red-100 text-red-900 border border-red-200';
      case 'image':
        return 'bg-indigo-100 text-indigo-900 border border-indigo-200';
      default:
        return 'bg-gray-100 text-gray-900 border border-gray-200';
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'tool_call':
        return toolTitle ? `Tool Call: ${toolTitle}` : 'Tool Call';
      case 'error':
        return 'Error';
      case 'image':
        return 'Image';
      default:
        return null;
    }
  };

  const typeLabel = getTypeLabel(displayType);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[70%] rounded-lg px-4 py-2 ${getMessageStyle(displayType)}`}>
        {typeLabel && (
          <div className="mb-1 text-xs font-medium opacity-75">{typeLabel}</div>
        )}
        <div className="prose prose-sm max-w-none break-words">
          {displayType === 'image' ? (
            <img
              src={displayContent.startsWith('data:') || displayContent.startsWith('http') ? displayContent : `data:image/png;base64,${displayContent}`}
              alt="ACP output"
              className="max-h-64 rounded"
            />
          ) : isUser ? (
            <div className="whitespace-pre-wrap">{displayContent}</div>
          ) : (
            <MarkdownContent content={displayContent} />
          )}
        </div>
        <div className={`mt-1 text-xs ${isUser ? 'text-blue-200' : 'text-gray-500'}`}>
          {new Date(message.createdAt).toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}
