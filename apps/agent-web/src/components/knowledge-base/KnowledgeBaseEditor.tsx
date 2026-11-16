import { useState } from 'react';
import { useMutation } from '@apollo/client/react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Save, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import TagBadgeInput from '@/components/knowledge-base/TagBadgeInput';
import MarkdownContent from '@/components/session/MarkdownContent';
import {
  CREATE_KNOWLEDGE_BASE_DOCUMENT,
  GET_KNOWLEDGE_BASE_DOCUMENT,
  GET_KNOWLEDGE_BASE_EVENTS,
  GET_KNOWLEDGE_BASE_TREE,
  UPDATE_KNOWLEDGE_BASE_DOCUMENT,
  type CreateKnowledgeBaseDocumentMutation,
  type KnowledgeBaseDocumentData,
  type KnowledgeBaseDocumentInput,
  type UpdateKnowledgeBaseDocumentMutation,
} from '@/graphql/knowledge-base';
import {
  clearDocumentDraft,
  readDocumentDraft,
  scheduleDocumentDraft,
  type KnowledgeBaseDraft,
} from '@/lib/knowledge-base-draft';
import { knowledgeBaseErrorMessage } from '@/lib/knowledge-base';
import { knowledgeBaseDocHref, normalizeDocumentPath } from '@/lib/knowledge-base-path';
import { formatDateTime } from '@/lib/format';

interface KnowledgeBaseEditorProps {
  kbId: string;
  path: string;
  /** 已存在文档；`null` 表示该路径尚无文档（保存时创建） */
  document: KnowledgeBaseDocumentData | null;
  canCreate: boolean;
  canUpdate: boolean;
  onCancel: () => void;
  onSaved?: (document: KnowledgeBaseDocumentData) => void;
}

const INVALID_PATH_MESSAGE = '文档路径不合法（需以 / 开头、无空路径段）';

/**
 * 分栏编辑（D10：原生 textarea + MarkdownContent 实时预览，不引入 Monaco）。
 *
 * 左栏实时预览、右栏路径/标题/描述/标签/内容；输入防抖 300ms 写入 localStorage 草稿，
 * 保存成功后清除。进入编辑时若存在草稿，弹出「恢复未保存的内容？」对话框（恢复/放弃）。
 *
 * 路径可修改（需求 #541 / 提案实现点 3）：已存在文档时一次 `updateKnowledgeBaseDocument(newPath)`
 * 原子完成「移动 + 更新」，成功后导航到新路径回预览态；文档不存在时以编辑后路径创建。
 */
export default function KnowledgeBaseEditor({
  kbId,
  path,
  document,
  canCreate,
  canUpdate,
  onCancel,
  onSaved,
}: KnowledgeBaseEditorProps) {
  const navigate = useNavigate();
  const [pendingDraft] = useState<KnowledgeBaseDraft | null>(() => readDocumentDraft(kbId, path));
  const [restoreOpen, setRestoreOpen] = useState<boolean>(() => pendingDraft !== null);
  const [editedPath, setEditedPath] = useState(path);
  const [title, setTitle] = useState(document?.title ?? '');
  const [tags, setTags] = useState<string[]>(document?.tags ?? []);
  const [description, setDescription] = useState(document?.description ?? '');
  const [content, setContent] = useState(document?.content ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [createDocument, { loading: creating }] = useMutation<CreateKnowledgeBaseDocumentMutation>(
    CREATE_KNOWLEDGE_BASE_DOCUMENT,
  );
  const [updateDocument, { loading: updating }] = useMutation<UpdateKnowledgeBaseDocumentMutation>(
    UPDATE_KNOWLEDGE_BASE_DOCUMENT,
  );

  const scheduleDraft = (next: {
    editedPath: string;
    title: string;
    tags: string[];
    description: string;
    content: string;
  }) => {
    scheduleDocumentDraft(kbId, path, {
      title: next.title,
      tags: next.tags,
      description: next.description,
      content: next.content,
      editedPath: next.editedPath,
    });
  };

  const handleRestore = () => {
    if (pendingDraft) {
      setTitle(pendingDraft.title);
      setTags(pendingDraft.tags);
      setDescription(pendingDraft.description);
      setContent(pendingDraft.content);
      setEditedPath(pendingDraft.editedPath ?? path);
    }
    setRestoreOpen(false);
  };

  const handleDiscardDraft = () => {
    clearDocumentDraft(kbId, path);
    setRestoreOpen(false);
  };

  const handleSave = async () => {
    if (saving || creating || updating) return;
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      setError('请输入文档标题');
      return;
    }
    if (trimmedTitle.length > 200) {
      setError('标题最多 200 个字符');
      return;
    }
    if (description.length > 1024) {
      setError('描述最多 1024 个字符');
      return;
    }
    if (content.length > 262_144) {
      setError('内容最多 262144 个字符');
      return;
    }
    // 客户端预校验仅体验层：服务端 normalizeDocumentPath 为权威
    const targetPath = normalizeDocumentPath(editedPath);
    if (!targetPath) {
      setError(INVALID_PATH_MESSAGE);
      return;
    }
    if (document ? !canUpdate : !canCreate) {
      setError('没有保存该文档的权限');
      return;
    }

    const input: KnowledgeBaseDocumentInput = {
      title: trimmedTitle,
      tags,
      description,
      content,
    };
    const moving = targetPath !== path;
    setError(null);
    setSaving(true);
    try {
      const refetchQueries = [
        { query: GET_KNOWLEDGE_BASE_TREE },
        { query: GET_KNOWLEDGE_BASE_DOCUMENT, variables: { knowledgeBaseId: kbId, path: targetPath } },
        { query: GET_KNOWLEDGE_BASE_EVENTS, variables: { knowledgeBaseId: kbId, path: targetPath } },
      ];
      let saved: KnowledgeBaseDocumentData | null = null;
      if (document) {
        const result = await updateDocument({
          variables: {
            knowledgeBaseId: kbId,
            path,
            input,
            ...(moving ? { newPath: targetPath } : {}),
          },
          refetchQueries,
        });
        saved = result.data?.updateKnowledgeBaseDocument ?? null;
      } else {
        const result = await createDocument({
          variables: { knowledgeBaseId: kbId, path: targetPath, input },
          refetchQueries,
        });
        saved = result.data?.createKnowledgeBaseDocument ?? null;
      }
      // 原子保存成功即无草稿语义：只清旧键，不在新路径下伪造草稿（D7）
      clearDocumentDraft(kbId, path);
      toast.success('文档已保存');
      // 先通知父级清 ?edit（其 setSearchParams 基于当前路径），再导航到新路径
      if (saved) onSaved?.(saved);
      if (moving) navigate(knowledgeBaseDocHref(kbId, targetPath));
    } catch (err) {
      setError(knowledgeBaseErrorMessage(err, '保存失败，请重试'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-w-0" data-testid="knowledge-base-editor">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">编辑文档</h1>
          <p className="truncate font-mono text-xs text-muted-foreground" title={path}>
            {path}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            <X className="size-3.5" />
            取消
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            <Save className="size-3.5" />
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>

      {error && (
        <p className="px-4 pb-2 text-xs text-destructive sm:px-6" role="alert" data-testid="knowledge-base-editor-error">
          {error}
        </p>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-4 px-4 pb-6 sm:px-6 lg:grid-cols-2">
        <section
          className="min-w-0 rounded-lg border border-border p-3"
          aria-label="实时预览"
          data-testid="knowledge-base-editor-preview"
        >
          <p className="mb-2 text-xs text-muted-foreground">实时预览</p>
          <div className="min-w-0">
            <h2 className="min-w-0 wrap-anywhere text-xl font-semibold">
              {title.trim() || '（未命名文档）'}
            </h2>
            {description.length > 0 && (
              <p className="mt-1 min-w-0 wrap-anywhere text-sm text-muted-foreground">{description}</p>
            )}
            {tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="max-w-full truncate">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
            <div className="mt-3 min-w-0 wrap-anywhere text-sm leading-6">
              <MarkdownContent content={content} />
            </div>
          </div>
        </section>

        <section className="min-w-0 space-y-3" aria-label="编辑表单">
          <div className="space-y-1.5">
            <Label htmlFor="kb-doc-path">路径</Label>
            <Input
              id="kb-doc-path"
              aria-label="路径"
              className="font-mono"
              value={editedPath}
              maxLength={512}
              onChange={(event) => {
                const next = event.target.value;
                setEditedPath(next);
                if (error) setError(null);
                scheduleDraft({ editedPath: next, title, tags, description, content });
              }}
            />
            {document && editedPath !== path && (
              <p className="text-xs text-muted-foreground">保存后将移动到该路径（历史随文档带入）。</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="kb-doc-title">标题</Label>
            <Input
              id="kb-doc-title"
              aria-label="标题"
              value={title}
              maxLength={200}
              onChange={(event) => {
                const next = event.target.value;
                setTitle(next);
                if (error) setError(null);
                scheduleDraft({ editedPath, title: next, tags, description, content });
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="kb-doc-tags">标签</Label>
            <TagBadgeInput
              id="kb-doc-tags"
              aria-label="标签"
              value={tags}
              placeholder="输入后回车或逗号生成标签"
              onChange={(next) => {
                setTags(next);
                if (error) setError(null);
                scheduleDraft({ editedPath, title, tags: next, description, content });
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="kb-doc-description">描述</Label>
            <textarea
              id="kb-doc-description"
              aria-label="描述"
              value={description}
              rows={3}
              maxLength={1024}
              className="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              onChange={(event) => {
                const next = event.target.value;
                setDescription(next);
                if (error) setError(null);
                scheduleDraft({ editedPath, title, tags, description: next, content });
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="kb-doc-content">内容（Markdown）</Label>
            <textarea
              id="kb-doc-content"
              aria-label="内容"
              value={content}
              rows={18}
              className="min-h-[320px] w-full min-w-0 resize-y whitespace-pre-wrap break-all rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              onChange={(event) => {
                const next = event.target.value;
                setContent(next);
                if (error) setError(null);
                scheduleDraft({ editedPath, title, tags, description, content: next });
              }}
            />
          </div>
        </section>
      </div>

      <Dialog
        open={restoreOpen}
        onOpenChange={(next) => {
          if (!next) setRestoreOpen(false);
        }}
      >
        <DialogContent data-testid="knowledge-base-draft-dialog">
          <DialogHeader>
            <DialogTitle>恢复未保存的内容？</DialogTitle>
            <DialogDescription>
              检测到该文档存在未保存的本地草稿
              {pendingDraft ? `（${formatDateTime(pendingDraft.updatedAt)}）` : ''}。恢复后可用草稿内容继续编辑，放弃则丢弃草稿并载入已保存内容。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={handleDiscardDraft}>
              放弃
            </Button>
            <Button onClick={handleRestore}>恢复</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
