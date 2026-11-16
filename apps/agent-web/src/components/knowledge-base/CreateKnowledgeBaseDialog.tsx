import { useEffect, useState } from 'react';
import { useMutation } from '@apollo/client/react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  CREATE_KNOWLEDGE_BASE,
  GET_KNOWLEDGE_BASES,
  GET_KNOWLEDGE_BASE_TREE,
  type CreateKnowledgeBaseMutation,
  type KnowledgeBaseData,
} from '@/graphql/knowledge-base';
import { knowledgeBaseErrorMessage } from '@/lib/knowledge-base';

interface CreateKnowledgeBaseDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (knowledgeBase: KnowledgeBaseData) => void;
}

/** 创建知识库对话框（分区「+」入口；非管理员不渲染入口，服务端仍为权威）。 */
export default function CreateKnowledgeBaseDialog({
  open,
  onClose,
  onCreated,
}: CreateKnowledgeBaseDialogProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [createKnowledgeBase, { loading }] = useMutation<CreateKnowledgeBaseMutation>(
    CREATE_KNOWLEDGE_BASE,
  );

  useEffect(() => {
    if (open) {
      setName('');
      setError(null);
    }
  }, [open]);

  const trimmed = name.trim();
  const invalid = trimmed.length === 0 || trimmed.length > 64;

  const handleSubmit = async () => {
    if (invalid || loading) return;
    setError(null);
    try {
      const result = await createKnowledgeBase({
        variables: { name: trimmed },
        refetchQueries: [{ query: GET_KNOWLEDGE_BASE_TREE }, { query: GET_KNOWLEDGE_BASES }],
      });
      const created = result.data?.createKnowledgeBase;
      toast.success('知识库已创建');
      if (created) onCreated?.(created);
      onClose();
    } catch (err) {
      setError(knowledgeBaseErrorMessage(err, '创建知识库失败，请重试'));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent data-testid="create-knowledge-base-dialog">
        <DialogHeader>
          <DialogTitle>新建知识库</DialogTitle>
          <DialogDescription>
            同一工作区内知识库名称唯一。默认权限模式由当前工作区类型决定（全局工作区默认只读，普通工作区默认仅管理员可见）。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="knowledge-base-name">名称</Label>
          <Input
            id="knowledge-base-name"
            aria-label="知识库名称"
            value={name}
            maxLength={64}
            placeholder="例如：团队开发规范"
            autoFocus
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleSubmit();
            }}
          />
          {invalid && trimmed.length > 64 && (
            <p className="text-xs text-destructive">名称最多 64 个字符</p>
          )}
          {error && (
            <p className="text-xs text-destructive" data-testid="knowledge-base-create-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            取消
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={invalid || loading}>
            {loading ? '创建中…' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
