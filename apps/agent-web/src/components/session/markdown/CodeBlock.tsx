import { useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy, WrapText } from 'lucide-react';
import { toast } from 'sonner';

interface CodeBlockProps {
  code: string;
  /** 无语言时展示 text 标签并按纯文本渲染 */
  language?: string;
}

export default function CodeBlock({ code, language }: CodeBlockProps) {
  const [wrap, setWrap] = useState(false);
  const displayLanguage = language || 'text';

  const handleCopy = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('clipboard unavailable');
      }
      await navigator.clipboard.writeText(code);
      toast.success('已复制');
    } catch {
      toast.error('复制失败');
    }
  };

  return (
    <div className="group my-2 overflow-hidden rounded-md border border-border bg-[#282c34]" data-testid="code-block">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-2 py-1">
        <span className="min-w-0 truncate font-mono text-xs text-gray-400" data-testid="code-block-language">
          {displayLanguage}
        </span>
        <div className="flex shrink-0 items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
          <button
            type="button"
            aria-label="复制代码"
            title="复制代码"
            onClick={handleCopy}
            className="rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-100"
          >
            <Copy className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={wrap ? '关闭自动换行' : '自动换行'}
            title={wrap ? '关闭自动换行' : '自动换行'}
            aria-pressed={wrap}
            onClick={() => setWrap((prev) => !prev)}
            className={`rounded p-1 hover:bg-white/10 hover:text-gray-100 ${wrap ? 'bg-white/10 text-gray-100' : 'text-gray-400'}`}
          >
            <WrapText className="size-3.5" />
          </button>
        </div>
      </div>
      <div className={wrap ? 'overflow-x-hidden' : 'overflow-x-auto'}>
        {language ? (
          <SyntaxHighlighter
            language={language}
            style={oneDark}
            PreTag="pre"
            customStyle={{
              margin: 0,
              padding: '0.75rem',
              background: 'transparent',
              overflow: 'visible',
            }}
            codeTagProps={{
              className: wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre',
              style: {
                whiteSpace: wrap ? 'pre-wrap' : 'pre',
                wordBreak: wrap ? 'break-all' : 'normal',
              },
            }}
          >
            {code}
          </SyntaxHighlighter>
        ) : (
          <pre
            className={`m-0 p-3 text-sm text-gray-100 ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'}`}
          >
            {code}
          </pre>
        )}
      </div>
    </div>
  );
}
