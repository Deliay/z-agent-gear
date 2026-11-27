import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@apollo/client/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DELETE_KNOWLEDGE_BASE,
  GET_KNOWLEDGE_BASES,
  GET_KNOWLEDGE_BASE_EVENTS,
  GET_KNOWLEDGE_BASE_TREE,
  RENAME_KNOWLEDGE_BASE,
  UPDATE_KNOWLEDGE_BASE_PERMISSION,
  type DeleteKnowledgeBaseMutation,
  type GetKnowledgeBaseEventsQuery,
  type KnowledgeBaseData,
  type KnowledgeBasePermissionMode,
  type RenameKnowledgeBaseMutation,
  type UpdateKnowledgeBasePermissionMutation,
} from '@/graphql/knowledge-base';
import {
  EVENT_OP_LABELS,
  KNOWLEDGE_BASE_PERMISSION_MODES,
  PERMISSION_MODE_DESCRIPTIONS,
  PERMISSION_MODE_LABELS,
  knowledgeBaseErrorMessage,
} from '@/lib/knowledge-base';
import { formatDateTime } from '@/lib/format';

interface KnowledgeBaseSettingsDialogProps {
  open: boolean;
  knowledgeBase: KnowledgeBaseData;
  onClose: () => void;
  /** 改名/权限变更后通知上层刷新树 */
  onChanged?: () => void;
  /** 删除知识库成功后由上层导航离开 */
  onDeleted?: () => void;
}

/**
 * 知识库设置：重命名、权限模式四档、全库操作历史（时间倒序）、删除（二次确认）。
 *
 * 管理操作以服务端 `myAccess.canManage` 为权威；非管理员仍可查看全库历史（需 canRead）。
 */
export default function KnowledgeBaseSettingsDialog({
  open,
  knowledgeBase,
  onClose,
  onChanged,
  onDeleted,
}: KnowledgeBaseSettingsDialogProps) {
  const [name, setName] = useState(knowledgeBase.name);
  const [currentName, setCurrentName] = useState(knowledgeBase.name);
  const [mode, setMode] = useState<KnowledgeBasePermissionMode>(knowledgeBase.permissionMode);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const canManage = knowledgeBase.myAccess.canManage;
  const canRead = knowledgeBase.myAccess.canRead;

  useEffect(() => {
    if (!open) return;
    setName(knowledgeBase.name);
    setCurrentName(knowledgeBase.name);
    setMode(knowledgeBase.permissionMode);
    setError(null);
    setDeleteOpen(false);
  }, [open, knowledgeBase.id, knowledgeBase.name, knowledgeBase.permissionMode]);

  const { data: eventsData, loading: eventsLoading } = useQuery<GetKnowledgeBaseEventsQuery>(
    GET_KNOWLEDGE_BASE_EVENTS,
    {
      variables: { knowledgeBaseId: knowledgeBase.id },
      skip: !open || !canRead,
      fetchPolicy: 'cache-and-network',
    },
  );
  const events = eventsData?.knowledgeBaseEvents ?? [];

  const [rename, { loading: renaming }] = useMutation<RenameKnowledgeBaseMutation>(
    RENAME_KNOWLEDGE_BASE,
  );
  const [updatePermission, { loading: updating }] = useMutation<UpdateKnowledgeBasePermissionMutation>(
    UPDATE_KNOWLEDGE_BASE_PERMISSION,
  );
  const [deleteKnowledgeBase, { loading: deleting }] = useMutation<DeleteKnowledgeBaseMutation>(
    DELETE_KNOWLEDGE_BASE,
  );

  const refetchTree = [
    { query: GET_KNOWLEDGE_BASE_TREE },
    { query: GET_KNOWLEDGE_BASES },
    { query: GET_KNOWLEDGE_BASE_EVENTS, variables: { knowledgeBaseId: knowledgeBase.id } },
  ];

  const handleRename = async () => {
    const trimmed = name.trim();
    if (!canManage || renaming) return;
    if (trimmed.length === 0 || trimmed.length > 64) {
      setError('知识库名称格式不正确（1~64 个字符）');
      return;
    }
    if (trimmed === currentName) return;
    setError(null);
    try {
      await rename({
        variables: { id: knowledgeBase.id, name: trimmed },
        refetchQueries: refetchTree,
      });
      setCurrentName(trimmed);
      toast.success('知识库已重命名');
      onChanged?.();
    } catch (err) {
      setError(knowledgeBaseErrorMessage(err, '重命名失败，请重试'));
    }
  };

  const handlePermissionChange = async (next: KnowledgeBasePermissionMode) => {
    if (!canManage || updating || next === mode) return;
    setError(null);
    const previous = mode;
    // 乐观更新：受控单选立即反映选择（服务端失败再回滚）
    setMode(next);
    try {
      await updatePermission({
        variables: { id: knowledgeBase.id, permissionMode: next },
        refetchQueries: refetchTree,
      });
      toast.success('权限模式已更新');
      onChanged?.();
    } catch (err) {
      setMode(previous);
      setError(knowledgeBaseErrorMessage(err, '更新权限模式失败，请重试'));
    }
  };

  const handleDelete = async () => {
    if (deleting) return;
    try {
      await deleteKnowledgeBase({
        variables: { id: knowledgeBase.id },
        refetchQueries: [{ query: GET_KNOWLEDGE_BASE_TREE }, { query: GET_KNOWLEDGE_BASES }],
      });
      toast.success('知识库已删除');
      setDeleteOpen(false);
      onDeleted?.();
    } catch (err) {
      setError(knowledgeBaseErrorMessage(err, '删除知识库失败，请重试'));
      setDeleteOpen(false);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <DialogContent className="sm:max-w-lg" data-testid="knowledge-base-settings-dialog">
          <DialogHeader>
            <DialogTitle>{currentName} · 知识库设置</DialogTitle>
            <DialogDescription>
              {canManage
                ? '重命名、调整权限模式或删除知识库；删除后其下文档与历史一并清除。'
                : '你没有管理权限，仅可查看全库操作历史。'}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 space-y-4 overflow-y-auto">
            {canManage && (
              <section className="space-y-1.5" aria-label="重命名知识库">
                <Label htmlFor="knowledge-base-rename">重命名</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="knowledge-base-rename"
                    aria-label="新的知识库名称"
                    value={name}
                    maxLength={64}
                    onChange={(event) => {
                      setName(event.target.value);
                      if (error) setError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void handleRename();
                    }}
                  />
                  <Button
                    variant="outline"
                    className="shrink-0"
                    disabled={renaming || name.trim() === currentName}
                    onClick={() => void handleRename()}
                  >
                    {renaming ? '保存中…' : '保存名称'}
                  </Button>
                </div>
              </section>
            )}

            {canManage && (
              <section className="space-y-1.5" aria-label="权限模式">
                <Label>权限模式</Label>
                <div
                  role="radiogroup"
                  aria-label="权限模式"
                  className="space-y-1.5 rounded-lg border border-border p-2"
                >
                  {KNOWLEDGE_BASE_PERMISSION_MODES.map((value) => (
                    <label
                      key={value}
                      className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted/50"
                    >
                      <input
                        type="radio"
                        name="knowledge-base-permission-mode"
                        value={value}
                        checked={mode === value}
                        disabled={updating}
                        onChange={() => void handlePermissionChange(value)}
                        className="mt-1"
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">
                          {value} · {PERMISSION_MODE_LABELS[value]}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {PERMISSION_MODE_DESCRIPTIONS[value]}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            )}

            {error && (
              <p className="text-xs text-destructive-text" role="alert" data-testid="knowledge-base-settings-error">
                {error}
              </p>
            )}

            <section className="space-y-1.5" aria-label="全库操作历史">
              <Label>全库操作历史</Label>
              {!canRead ? (
                <p className="text-xs text-muted-foreground">没有查看历史的权限。</p>
              ) : eventsLoading && !eventsData ? (
                <p className="text-xs text-muted-foreground">加载中…</p>
              ) : events.length === 0 ? (
                <p className="text-xs text-muted-foreground">暂无历史记录</p>
              ) : (
                <ul
                  className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border p-2"
                  data-testid="knowledge-base-events"
                >
                  {events.map((event) => (
                    <li
                      key={event.id}
                      className="flex min-w-0 items-start gap-2 text-xs"
                      data-testid="knowledge-base-event"
                    >
                      <span className="shrink-0 rounded bg-muted px-1 py-0.5">
                        {EVENT_OP_LABELS[event.op]}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className="block truncate font-mono text-xs"
                          title={
                            event.op === 'MOVE' && event.fromPath
                              ? `${event.fromPath} → ${event.path}`
                              : event.path
                          }
                        >
                          {event.op === 'MOVE' && event.fromPath
                            ? `${event.fromPath} → ${event.path}`
                            : event.path}
                        </span>
                        <span className="block truncate text-muted-foreground">
                          {event.actorName} · {formatDateTime(event.createdAt)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <DialogFooter className="flex-col items-stretch sm:flex-row sm:items-center sm:justify-between">
            {canManage ? (
              <Button
                variant="destructive"
                className="shrink-0"
                onClick={() => setDeleteOpen(true)}
                disabled={deleting}
              >
                删除知识库
              </Button>
            ) : (
              <span />
            )}
            <Button variant="outline" onClick={onClose}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`删除知识库「${currentName}」？`}
        description="删除后其下全部文档与历史记录将一并清除，且无法恢复。请输入前请确认。"
        confirmLabel="删除"
        loading={deleting}
        onConfirm={handleDelete}
      />
    </>
  );
}
