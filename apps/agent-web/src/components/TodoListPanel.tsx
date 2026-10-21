import { useState, useEffect, useRef } from 'react';
import { useMutation } from '@apollo/client/react';
import { Bell, Check } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { ScrollArea } from './ui/scroll-area';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { HOME_OVERVIEW } from '../graphql/home';
import { MARK_ALL_TODO_READ } from '../graphql/mutations';
import { PermissionDialog } from './PermissionDialog';
import { ElicitationDialog } from './ElicitationDialog';
import { useHomeOverview } from '../stores/homeOverview';
import { useElicitationDialogState } from '../stores/elicitationDialog';
import type { TodoItemData } from '../graphql/types';

function isActionablePermission(todo: TodoItemData): boolean {
  return todo.type === 'permission_request' && !!todo.data;
}

function isActionableElicitation(todo: TodoItemData): boolean {
  return todo.type === 'elicitation_request' && !!todo.elicitationData && !todo.resolution;
}

// 可交互弹窗的待办类型（已 resolved 的问询不再自动弹出）
function isActionable(todo: TodoItemData): boolean {
  return isActionablePermission(todo) || isActionableElicitation(todo);
}

export function TodoListPanel() {
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);
  const [immediateTodoId, setImmediateTodoId] = useState<string | null>(null);
  const processedImmediateRef = useRef<Set<string>>(new Set());
  // 问询弹窗打开权与会话内 Banner 共享（同一时刻只有 owner 一方持有）
  const {
    todoId: elicitationTodoId,
    owner: elicitationOwner,
    snapshot: elicitationSnapshot,
    open: openElicitation,
    close: closeElicitation,
  } = useElicitationDialogState();

  // 待办随首页聚合查询统一下发（轮询周期与首页一致：15s）
  const { data, refetch: refetchOverview } = useHomeOverview();
  const [markAllTodoRead] = useMutation(MARK_ALL_TODO_READ, {
    refetchQueries: [{ query: HOME_OVERVIEW }],
  });

  const todos: TodoItemData[] = data?.todos ?? [];
  const unreadCount = data?.unreadTodoCount ?? 0;

  // 只存 id：轮询拿到新数据（如问询被标记 expired）时弹窗内容随之收敛
  const selectedTodo = selectedTodoId
    ? todos.find((todo) => todo.id === selectedTodoId) ?? null
    : null;
  const immediateTodo = immediateTodoId
    ? todos.find((todo) => todo.id === immediateTodoId) ?? null
    : null;
  // 问询弹窗数据按 id 从全量 todos 派生（不过滤 resolution）：轮询后自动收敛为终态；
  // todo 被 TTL 删除/limit 挤出时退回打开时快照并标记 stale，不静默卸载表单
  const liveElicitationTodo = elicitationOwner === 'todo' && elicitationTodoId
    ? todos.find((todo) => todo.id === elicitationTodoId) ?? null
    : null;
  const elicitationTodo = liveElicitationTodo
    ?? (elicitationOwner === 'todo' ? elicitationSnapshot : null);
  const elicitationStale = Boolean(elicitationTodo) && !liveElicitationTodo;
  // 列表已移除该 todo：不再用它阻塞后续 immediate 自动弹窗
  const elicitationBlocking = Boolean(elicitationTodoId) && !elicitationStale;

  // 面板卸载时清理自己持有的状态
  useEffect(() => () => closeElicitation('todo'), [closeElicitation]);

  // 检测立即优先级的待办，自动弹出全局弹窗（三种弹窗互斥）
  useEffect(() => {
    if (selectedTodoId || immediateTodoId || elicitationBlocking) return;
    const immediate = todos.find(
      (todo) => todo.priority === 'immediate' && !todo.isRead && isActionable(todo) && !processedImmediateRef.current.has(todo.id)
    );
    if (!immediate) return;
    processedImmediateRef.current.add(immediate.id);
    if (isActionableElicitation(immediate)) {
      openElicitation(immediate, 'todo');
    } else {
      setImmediateTodoId(immediate.id);
    }
  }, [todos, selectedTodoId, immediateTodoId, elicitationBlocking, openElicitation]);

  const handleMarkAllRead = async () => {
    // mutation 已带 refetchQueries: HOME_OVERVIEW，避免二次全量刷新
    await markAllTodoRead();
  };

  const handleTodoClick = (todo: TodoItemData) => {
    if (todo.isRead || !isActionable(todo)) return;
    if (isActionableElicitation(todo)) {
      // 问询走共享弹窗状态：与 Banner 互斥，避免同一 requestId 双弹窗
      setSelectedTodoId(null);
      setImmediateTodoId(null);
      openElicitation(todo, 'todo');
      return;
    }
    closeElicitation('todo');
    setSelectedTodoId(todo.id);
  };

  const handleDialogOpenChange = (open: boolean) => {
    if (!open) {
      setSelectedTodoId(null);
      setImmediateTodoId(null);
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

      {elicitationTodo && (
        <ElicitationDialog
          open
          stale={elicitationStale}
          onOpenChange={(open) => {
            if (!open) closeElicitation('todo');
          }}
          todo={elicitationTodo}
          onResponded={() => {
            closeElicitation('todo');
            refetchOverview();
          }}
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
