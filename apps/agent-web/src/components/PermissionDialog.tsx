import { useState } from 'react';
import { useMutation, useQuery } from '@apollo/client/react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { RESPOND_PERMISSION } from '../graphql/mutations';
import { GET_SESSION_MESSAGES } from '../graphql/queries';
import type { TodoItemData, RespondPermissionMutation, GetSessionMessagesQuery } from '../graphql/types';
import ToolCallCard from './session/ToolCallCard';

interface PermissionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  todo: TodoItemData;
}

export function PermissionDialog({ open, onOpenChange, todo }: PermissionDialogProps) {
  const [responding, setResponding] = useState(false);
  const [respondPermission] = useMutation<RespondPermissionMutation>(RESPOND_PERMISSION);

  // 获取session消息，用于查找ToolCall
  const { data: messagesData } = useQuery<GetSessionMessagesQuery>(GET_SESSION_MESSAGES, {
    variables: { sessionId: todo.data?.sessionId, limit: 100 },
    skip: !todo.data?.sessionId,
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

          {/* 显示ToolCall卡片 */}
          {toolCallMessage && (
            <div className="border rounded-lg p-2">
              <ToolCallCard 
                messages={[toolCallMessage]} 
                expanded={true}
              />
            </div>
          )}

          {/* 如果没有找到ToolCall消息，显示toolCallId */}
          {!toolCallMessage && todo.data.toolCallId && (
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
