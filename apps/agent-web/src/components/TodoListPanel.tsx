import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation } from '@apollo/client/react';
import { Bell, Check } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { GET_TODO_LIST, GET_UNREAD_TODO_COUNT } from '../graphql/queries';
import { MARK_ALL_TODO_READ } from '../graphql/mutations';
import { PermissionDialog } from './PermissionDialog';
import type { TodoItemData, GetTodoListQuery, GetUnreadTodoCountQuery } from '../graphql/types';

export function TodoListPanel() {
  const [selectedTodo, setSelectedTodo] = useState<TodoItemData | null>(null);
  const [immediateTodo, setImmediateTodo] = useState<TodoItemData | null>(null);
  const processedImmediateRef = useRef<Set<string>>(new Set());
  
  const { data: todoData, refetch: refetchTodos } = useQuery<GetTodoListQuery>(GET_TODO_LIST, {
    pollInterval: 5000,
  });
  const { data: countData } = useQuery<GetUnreadTodoCountQuery>(GET_UNREAD_TODO_COUNT, {
    pollInterval: 5000,
  });
  const [markAllTodoRead] = useMutation(MARK_ALL_TODO_READ);

  const todos: TodoItemData[] = todoData?.getTodoList ?? [];
  const unreadCount = countData?.getUnreadTodoCount ?? 0;

  // 检测立即优先级的待办，自动弹出全局弹窗
  useEffect(() => {
    const immediate = todos.find(
      (todo) => todo.priority === 'immediate' && !todo.isRead && todo.type === 'permission_request' && todo.data && !processedImmediateRef.current.has(todo.id)
    );
    if (immediate) {
      processedImmediateRef.current.add(immediate.id);
      setImmediateTodo(immediate);
    }
  }, [todos]);

  const handleMarkAllRead = async () => {
    await markAllTodoRead();
    refetchTodos();
  };

  const handleTodoClick = (todo: TodoItemData) => {
    if (todo.type === 'permission_request' && todo.data && !todo.isRead) {
      setSelectedTodo(todo);
    }
  };

  const handleImmediateDialogClose = () => {
    setImmediateTodo(null);
  };

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" className="relative" aria-label="待办事项">
            <Bell className="h-5 w-5" />
            {unreadCount > 0 && (
              <Badge
                variant="destructive"
                className="absolute -top-1 -right-1 h-5 w-5 rounded-full p-0 flex items-center justify-center text-xs"
              >
                {unreadCount > 99 ? '99+' : unreadCount}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80" align="end">
          <div className="flex justify-between items-center mb-2">
            <h4 className="font-medium">待办事项</h4>
            <Button variant="ghost" size="sm" onClick={handleMarkAllRead}>
              <Check className="h-4 w-4 mr-1" />
              全部已读
            </Button>
          </div>
          <ScrollArea className="h-[300px]">
            {todos.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                暂无待办事项
              </p>
            ) : (
              <div className="space-y-2">
                {todos.map((todo) => (
                  <div
                    key={todo.id}
                    className={`p-3 rounded-lg border cursor-pointer hover:bg-accent ${
                      !todo.isRead ? 'bg-accent/50' : ''
                    } ${todo.priority === 'immediate' ? 'border-destructive' : ''}`}
                    onClick={() => handleTodoClick(todo)}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{todo.title}</span>
                      {!todo.isRead && (
                        <div className="h-2 w-2 rounded-full bg-blue-500" />
                      )}
                    </div>
                    {todo.description && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {todo.description}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      {new Date(todo.createdAt).toLocaleString()}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </PopoverContent>
      </Popover>

      {selectedTodo && (
        <PermissionDialog
          open={!!selectedTodo}
          onOpenChange={(open) => {
            if (!open) setSelectedTodo(null);
          }}
          todo={selectedTodo}
        />
      )}

      {immediateTodo && (
        <PermissionDialog
          open={!!immediateTodo}
          onOpenChange={(open) => {
            if (!open) handleImmediateDialogClose();
          }}
          todo={immediateTodo}
        />
      )}
    </>
  );
}
