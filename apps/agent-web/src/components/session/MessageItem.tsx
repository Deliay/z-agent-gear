import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { SessionUpdate } from '@agentclientprotocol/sdk';

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

  const acpUpdate = (() => { try { return JSON.parse(message.content) as SessionUpdate; } catch { return null; } })();

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
      case 'plan':
        return 'plan';
      default:
        return message.type;
    }
  })();

  const displayContent = (() => {
    if (!acpUpdate) return message.content;
    switch (acpUpdate.sessionUpdate) {
      case 'agent_message_chunk':
      case 'user_message_chunk':
        return acpUpdate.content.type === 'text' ? acpUpdate.content.text : '';
      case 'tool_call':
        return acpUpdate.title;
      case 'tool_call_update':
        return acpUpdate.title || '';
      case 'plan':
        return acpUpdate.entries?.map(e => e.content).join('\n') || '';
      default:
        return message.content;
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
      case 'plan':
        return 'bg-yellow-100 text-yellow-900 border border-yellow-200';
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
      case 'plan':
        return 'Plan';
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
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                code(props) {
                  const { children, className, ...rest } = props;
                  const match = /language-(\w+)/.exec(className || '');
                  const codeString = String(children).replace(/\n$/, '');
                  if (match) {
                    return (
                      <SyntaxHighlighter
                        style={oneDark}
                        language={match[1]}
                        PreTag="div"
                        className="rounded-md !my-2"
                      >
                        {codeString}
                      </SyntaxHighlighter>
                    );
                  }
                  return (
                    <code
                      className="rounded bg-gray-100 px-1.5 py-0.5 text-sm font-mono"
                      {...rest}
                    >
                      {children}
                    </code>
                  );
                },
                p(props) {
                  return <p className="!my-1 last:!mb-0" {...props} />;
                },
                ul(props) {
                  return <ul className="!my-1 list-disc pl-4" {...props} />;
                },
                ol(props) {
                  return <ol className="!my-1 list-decimal pl-4" {...props} />;
                },
                li(props) {
                  return <li className="!my-0.5" {...props} />;
                },
                pre(props) {
                  return <pre className="!my-0" {...props} />;
                },
              }}
            >
              {displayContent}
            </Markdown>
          )}
        </div>
        <div className={`mt-1 text-xs ${isUser ? 'text-blue-200' : 'text-gray-500'}`}>
          {new Date(message.createdAt).toLocaleTimeString()}
        </div>
      </div>
    </div>
  );
}
