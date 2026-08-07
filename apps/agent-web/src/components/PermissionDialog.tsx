import { useState } from 'react';
import { useMutation, useQuery } from '@apollo/client/react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { RESPOND_PERMISSION } from '../graphql/mutations';
import { GET_SESSION_MESSAGES } from '../graphql/queries';
import type { TodoItemData, PermissionToolCallData, RespondPermissionMutation, GetSessionMessagesQuery } from '../graphql/types';
import ToolCallCard from './session/ToolCallCard';

const SUMMARY_MAX_LENGTH = 200;

// 生成工具调用参数摘要：execute→命令、edit/write/delete→文件路径、其他→JSON 摘要
function summarizeToolCall(toolCall: PermissionToolCallData): string | null {
  const raw = toolCall.rawInput;
  if (!raw) return null;
  if (toolCall.kind === 'execute' && typeof raw.command === 'string' && raw.command) {
    return raw.command;
  }
  if (toolCall.kind === 'edit' || toolCall.kind === 'write' || toolCall.kind === 'delete') {
    const filePath = raw.filePath ?? raw.path;
    if (typeof filePath === 'string' && filePath) return filePath;
  }
  try {
    const json = JSON.stringify(raw);
    return json.length > SUMMARY_MAX_LENGTH ? `${json.slice(0, SUMMARY_MAX_LENGTH)}…` : json;
  } catch {
    return null;
  }
}

interface PermissionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  todo: TodoItemData;
}

export function PermissionDialog({ open, onOpenChange, todo }: PermissionDialogProps) {
  const [responding, setResponding] = useState(false);
  const [respondPermission] = useMutation<RespondPermissionMutation>(RESPOND_PERMISSION);

  // 优先使用后端下发的完整工具调用信息
  const toolCall = todo.data?.toolCall;
  const toolCallDetail = toolCall && (toolCall.title || toolCall.rawInput) ? toolCall : null;
  const toolCallSummary = toolCallDetail ? summarizeToolCall(toolCallDetail) : null;

  // 获取session消息，用于查找ToolCall（已有完整工具调用信息时作为兜底不查询）
  const { data: messagesData } = useQuery<GetSessionMessagesQuery>(GET_SESSION_MESSAGES, {
    variables: { sessionId: todo.data?.sessionId, limit: 100 },
    skip: !todo.data?.sessionId || !!toolCallDetail,
  });

  const messages = messagesData?.sessionMessages ?? [];
  
  // 查找对应的ToolCall消息
  const toolCallMessage = todo.data?.toolCallId 
    ? messages.find((msg) => {
        try {
          const content = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
          return content?.toolCallId === todo.data?.toolCallId || 
                 content?.sessionUpdate === 'tool_call' && content?.toolCallId === todo.data?.toolCallId ||
                 content?.sessionUpdate === 'tool_call_update' && content?.toolCallId === todo.data?.toolCallId;
        } catch {
          return false;
        }
      })
    : null;

  const handleRespond = async (optionId?: string) => {
    if (!todo.data) return;

    setResponding(true);
    try {
      await respondPermission({
        variables: {
          requestId: todo.data.requestId,
          outcome: optionId ? 'selected' : 'cancelled',
          optionId,
        },
      });
      onOpenChange(false);
    } catch (error) {
      console.error('Error responding to permission:', error);
    } finally {
      setResponding(false);
    }
  };

  if (!todo.data) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{todo.title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {todo.description && (
            <p className="text-sm text-muted-foreground">{todo.description}</p>
          )}

          {/* 优先展示后端下发的完整工具调用信息 */}
          {toolCallDetail && (
            <div className="border rounded-lg p-3 space-y-2">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">{toolCallDetail.title || '工具调用'}</p>
                {toolCallDetail.kind && (
                  <Badge variant="secondary">{toolCallDetail.kind}</Badge>
                )}
              </div>
              {toolCallSummary && (
                <pre className="text-xs font-mono bg-muted rounded p-2 whitespace-pre-wrap break-all">
                  {toolCallSummary}
                </pre>
              )}
              {toolCallDetail.locations && toolCallDetail.locations.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1">涉及文件</p>
                  <ul className="text-xs font-mono text-muted-foreground space-y-0.5">
                    {toolCallDetail.locations.map((loc, index) => (
                      <li key={`${loc.path}-${index}`}>
                        {loc.path}{loc.line != null ? `:${loc.line}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* 显示ToolCall卡片 */}
          {!toolCallDetail && toolCallMessage && (
            <div className="border rounded-lg p-2">
              <ToolCallCard 
                messages={[toolCallMessage]} 
                expanded={true}
              />
            </div>
          )}

          {/* 如果没有找到ToolCall消息，显示toolCallId */}
          {!toolCallDetail && !toolCallMessage && todo.data.toolCallId && (
            <div className="p-3 bg-muted rounded-lg">
              <p className="text-sm font-medium">工具调用 ID</p>
              <p className="text-xs text-muted-foreground font-mono">
                {todo.data.toolCallId}
              </p>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {todo.data.options.map((option) => (
              <Button
                key={option.optionId}
                variant={option.kind.startsWith('allow') ? 'default' : 'destructive'}
                onClick={() => handleRespond(option.optionId)}
                disabled={responding}
              >
                {option.name}
              </Button>
            ))}
            <Button
              variant="outline"
              onClick={() => handleRespond()}
              disabled={responding}
            >
              取消
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
