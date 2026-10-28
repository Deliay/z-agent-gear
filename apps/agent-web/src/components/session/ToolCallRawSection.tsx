import { useMemo, useState } from 'react';
import CodeBlock from './markdown/CodeBlock';
import { RAW_CONTENT_CHAR_LIMIT, RAW_CONTENT_LINE_LIMIT, formatRawValue } from '../../lib/raw-value';

interface ToolCallRawSectionProps {
  label: string;
  value: unknown;
  /** 值缺失时的占位文案（如创建事件缺失导致输入不可得），不传则不渲染 */
  missingHint?: string;
}

/** 原始输入/输出折叠区（默认折叠，JSON 美化 + 超 500 行/长串截断提示） */
export default function ToolCallRawSection({ label, value, missingHint }: ToolCallRawSectionProps) {
  const [open, setOpen] = useState(false);
  // 折叠态不做 JSON 序列化（M-8）
  const formatted = useMemo(() => (open ? formatRawValue(value) : null), [open, value]);

  if (value === undefined) {
    if (!missingHint) return null;
    return (
      <div
        className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground"
        data-testid={`raw-section-${label}`}
      >
        {missingHint}
      </div>
    );
  }

  return (
    <div className="mt-2 border-t border-border pt-2" data-testid={`raw-section-${label}`}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? '收起' : '查看'}原始{label}
      </button>
      {open && formatted && (
        <div className="mt-1">
          <CodeBlock code={formatted.text} language="json" />
          {formatted.truncated && (
            <div className="text-xs text-muted-foreground">
              内容过长，仅展示前 {RAW_CONTENT_LINE_LIMIT} 行 / {RAW_CONTENT_CHAR_LIMIT} 字符
            </div>
          )}
        </div>
      )}
    </div>
  );
}
