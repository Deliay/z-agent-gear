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
import { ElicitationDialog } from './ElicitationDialog';
import type { TodoItemData, GetTodoListQuery, GetUnreadTodoCountQuery } from '../graphql/types';

// 可交互弹窗的待办类型
function isActionable(todo: TodoItemData): boolean {
  return (
    (todo.type === 'permission_request' && !!todo.data) ||
    (todo.type === 'elicitation_request' && !!todo.elicitationData)
  );
}

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

  // 检测立即优先级的待办，自动弹出全局弹窗（与手动打开的弹窗互斥）
  useEffect(() => {
    if (selectedTodo || immediateTodo) return;
    const immediate = todos.find(
      (todo) => todo.priority === 'immediate' && !todo.isRead && isActionable(todo) && !processedImmediateRef.current.has(todo.id)
    );
    if (immediate) {
      processedImmediateRef.current.add(immediate.id);
      setImmediateTodo(immediate);
    }
  }, [todos, selectedTodo, immediateTodo]);

  const handleMarkAllRead = async () => {
    await markAllTodoRead();
    refetchTodos();
  };

  const handleTodoClick = (todo: TodoItemData) => {
    if (!todo.isRead && isActionable(todo)) {
      setSelectedTodo(todo);
    }
  };

  const handleDialogOpenChange = (open: boolean) => {
    if (!open) {
      setSelectedTodo(null);
      setImmediateTodo(null);
    }
  };

  // 两种弹窗互斥：同一时刻只展示一个
  const activeTodo = selectedTodo ?? immediateTodo;

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
                      <div className="flex items-center gap-1">
                        {todo.type === 'permission_request' && (
                          <Badge variant="outline" className="text-xs">权限</Badge>
                        )}
                        {todo.type === 'elicitation_request' && (
                          <Badge variant="outline" className="text-xs">信息请求</Badge>
                        )}
                        {todo.type === 'workflow_intervention' && (
                          <Badge variant="destructive" className="text-xs">人工介入</Badge>
                        )}
                        {!todo.isRead && (
                          <div className="h-2 w-2 rounded-full bg-info" />
                        )}
                      </div>
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

      {activeTodo && activeTodo.type === 'elicitation_request' && (
        <ElicitationDialog
          open={!!activeTodo}
          onOpenChange={handleDialogOpenChange}
          todo={activeTodo}
          onResponded={() => refetchTodos()}
        />
      )}

      {activeTodo && activeTodo.type !== 'elicitation_request' && (
        <PermissionDialog
          open={!!activeTodo}
          onOpenChange={handleDialogOpenChange}
          todo={activeTodo}
        />
      )}
    </>
  );
}
