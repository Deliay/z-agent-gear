import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';

/** 与服务端输入白名单同值（服务端始终是权威）。 */
export const TAG_MAX_LENGTH = 32;
export const TAG_MAX_COUNT = 16;

interface TagBadgeInputProps {
  value: string[];
  onChange(tags: string[]): void;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  placeholder?: string;
}

/**
 * 标签徽章编辑器（需求 #541 / 提案实现点 4、D6）。
 *
 * - 提交触发：Enter / `,` / `，` / blur（非空）；提交前 trim，与既有徽章重复 → toast 且不添加；
 * - 删除：徽章 `×` 逐枚删除；输入为空时 Backspace 删除末枚；
 * - 粘贴：文本含中英文逗号 → 拆分后逐枚走同一提交管线（去重 / 单枚 ≤32 / 总量 ≤16）；
 * - 上限：输入框 `maxLength=32`；徽章达 16 枚 → 输入框禁用并提示；
 * - IME：组合态期间 Enter 不提交（对齐 FragmentEditor 先例）。
 *
 * 自足实现（不引第三方 tag 库）：容器内复用既有 `Badge` + 文本 `×` 删除按钮。
 */
export default function TagBadgeInput({
  value,
  onChange,
  disabled = false,
  id,
  'aria-label': ariaLabel,
  placeholder,
}: TagBadgeInputProps) {
  const [draft, setDraft] = useState('');
  const composingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const full = value.length >= TAG_MAX_COUNT;
  const inputDisabled = disabled || full;

  const commit = (raw: string): void => {
    const candidates = raw
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    if (candidates.length === 0) return;

    const next = [...value];
    let duplicate = 0;
    let tooLong = 0;
    let overflow = 0;
    for (const candidate of candidates) {
      if (next.includes(candidate)) {
        duplicate += 1;
        continue;
      }
      if (candidate.length > TAG_MAX_LENGTH) {
        tooLong += 1;
        continue;
      }
      if (next.length >= TAG_MAX_COUNT) {
        overflow += 1;
        continue;
      }
      next.push(candidate);
    }

    if (next.length !== value.length) onChange(next);

    const messages: string[] = [];
    if (duplicate > 0) messages.push(`${duplicate} 个重复标签已忽略`);
    if (tooLong > 0) messages.push(`${tooLong} 个标签超过 ${TAG_MAX_LENGTH} 个字符已忽略`);
    if (overflow > 0) messages.push(`${overflow} 个标签超出 ${TAG_MAX_COUNT} 个上限已忽略`);
    if (messages.length > 0) toast.error(messages.join('；'));
  };

  const removeAt = (index: number): void => {
    if (disabled) return;
    onChange(value.filter((_tag, current) => current !== index));
  };

  const handleCommitDraft = (): void => {
    if (draft.trim().length === 0) {
      setDraft('');
      return;
    }
    commit(draft);
    setDraft('');
  };

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1 rounded-lg border border-input px-2 py-1.5 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
      data-testid="tag-badge-input"
      onClick={() => {
        if (!inputDisabled) inputRef.current?.focus();
      }}
    >
      {value.map((tag, index) => (
        <Badge
          key={tag}
          variant="outline"
          className="max-w-full gap-1 py-0 pr-1"
          data-testid="tag-badge"
        >
          <span className="max-w-[12rem] truncate">{tag}</span>
          <button
            type="button"
            aria-label={`删除标签 ${tag}`}
            className="rounded text-muted-foreground hover:text-foreground disabled:opacity-50"
            disabled={disabled}
            // 阻止 blur 先于 click 提交草稿，避免同一次点击的两次 onChange 互相覆盖
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              removeAt(index);
            }}
          >
            ×
          </button>
        </Badge>
      ))}

      <input
        ref={inputRef}
        id={id}
        aria-label={ariaLabel}
        className="h-6 min-w-[6rem] flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
        value={draft}
        maxLength={TAG_MAX_LENGTH}
        placeholder={full ? `最多 ${TAG_MAX_COUNT} 个标签` : placeholder}
        disabled={inputDisabled}
        onChange={(event) => setDraft(event.target.value)}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            event.preventDefault();
            handleCommitDraft();
            return;
          }
          if (event.key === 'Backspace' && draft.length === 0 && value.length > 0) {
            event.preventDefault();
            removeAt(value.length - 1);
          }
        }}
        onPaste={(event) => {
          const text = event.clipboardData?.getData('text') ?? '';
          if (!/[,，]/.test(text)) return;
          event.preventDefault();
          commit(text);
          setDraft('');
        }}
        onBlur={handleCommitDraft}
      />
    </div>
  );
}
