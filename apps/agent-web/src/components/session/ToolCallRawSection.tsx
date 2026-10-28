import { useState } from 'react';
import CodeBlock from './markdown/CodeBlock';
import { RAW_CONTENT_LINE_LIMIT, formatRawValue } from '../../lib/raw-value';

interface ToolCallRawSectionProps {
  label: string;
  value: unknown;
}

/** 原始输入/输出折叠区（默认折叠，JSON 美化 + 超 500 行截断提示） */
export default function ToolCallRawSection({ label, value }: ToolCallRawSectionProps) {
  const [open, setOpen] = useState(false);
  if (value === undefined) return null;

  const { text, truncated } = formatRawValue(value);

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
      {open && (
        <div className="mt-1">
          <CodeBlock code={text} language="json" />
          {truncated && (
            <div className="text-xs text-muted-foreground">
              内容过长，仅展示前 {RAW_CONTENT_LINE_LIMIT} 行
            </div>
          )}
        </div>
      )}
    </div>
  );
}
