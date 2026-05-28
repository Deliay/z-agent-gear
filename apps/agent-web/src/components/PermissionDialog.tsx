import { useState } from 'react';
import { useMutation } from '@apollo/client/react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { RESPOND_PERMISSION } from '../graphql/mutations';
import type { TodoItemData, RespondPermissionMutation } from '../graphql/types';

interface PermissionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  todo: TodoItemData;
}

export function PermissionDialog({ open, onOpenChange, todo }: PermissionDialogProps) {
  const [responding, setResponding] = useState(false);
  const [respondPermission] = useMutation<RespondPermissionMutation>(RESPOND_PERMISSION);

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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{todo.title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {todo.description && (
            <p className="text-sm text-muted-foreground">{todo.description}</p>
          )}

          <div className="p-3 bg-muted rounded-lg">
            <p className="text-sm font-medium">工具调用 ID</p>
            <p className="text-xs text-muted-foreground font-mono">
              {todo.data.toolCallId}
            </p>
          </div>

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
