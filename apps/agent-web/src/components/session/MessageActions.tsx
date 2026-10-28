import { Copy, FileText } from 'lucide-react';
import { toast } from 'sonner';

interface MessageActionsProps {
  /** 与展示同源的合成文本（复制 Markdown 口径） */
  content: string;
  /** 渲染后 DOM 的纯文本（复制纯文本口径） */
  getPlainText?: () => string;
}

export default function MessageActions({ content, getPlainText }: MessageActionsProps) {
  const copy = async (text: string) => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('clipboard unavailable');
      }
      await navigator.clipboard.writeText(text);
      toast.success('已复制');
    } catch {
      toast.error('复制失败');
    }
  };

  return (
    <div
      className="flex shrink-0 items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
      data-testid="message-actions"
    >
      <button
        type="button"
        aria-label="复制 Markdown"
        title="复制 Markdown"
        onClick={() => void copy(content)}
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Copy className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="复制纯文本"
        title="复制纯文本"
        onClick={() => void copy(getPlainText?.() ?? content)}
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <FileText className="size-3.5" />
      </button>
    </div>
  );
}
