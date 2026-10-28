import { useMemo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { computeDiff, type DiffLine } from '../../lib/diff';
import { languageFromPath } from '../../lib/language-from-path';

interface DiffViewProps {
  oldText?: string | null;
  newText: string;
  filePath?: string;
  inline?: boolean;
}

function HighlightedLine({ text, language }: { text: string; language: string }) {
  if (!text) return <span> </span>;
  if (language === 'text') return <span>{text}</span>;
  return (
    <SyntaxHighlighter
      language={language}
      style={oneDark}
      PreTag="span"
      CodeTag="span"
      customStyle={{ display: 'inline', margin: 0, padding: 0, background: 'transparent' }}
      codeTagProps={{ style: { fontFamily: 'inherit', fontSize: 'inherit' } }}
    >
      {text}
    </SyntaxHighlighter>
  );
}

function lineClass(type: DiffLine['type']) {
  switch (type) {
    case 'removed': return 'bg-destructive/10 text-destructive';
    case 'added': return 'bg-success/10 text-success';
    default: return 'text-foreground';
  }
}

function prefix(type: DiffLine['type']) {
  switch (type) {
    case 'removed': return '−';
    case 'added': return '+';
    default: return ' ';
  }
}

export default function DiffView({ oldText, newText, filePath, inline }: DiffViewProps) {
  const isNewFile = oldText == null;
  const language = useMemo(() => languageFromPath(filePath), [filePath]);
  const diffs = useMemo(
    () => computeDiff(isNewFile ? '' : (oldText ?? ''), newText ?? ''),
    [isNewFile, oldText, newText],
  );

  const containerClass = inline
    ? 'rounded border border-border text-xs'
    : 'rounded-lg border border-border text-sm';

  return (
    <div className={containerClass} data-testid="diff-view">
      {filePath && (
        <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">
          <span className="min-w-0 break-all">{filePath}</span>
          {isNewFile && (
            <span className="shrink-0 rounded bg-success/20 px-1.5 py-0.5 text-[10px] font-semibold text-success">
              新建文件
            </span>
          )}
        </div>
      )}
      <div className="overflow-x-auto">
        <pre className={`${inline ? 'max-h-48' : 'max-h-96'} m-0 overflow-y-auto p-0 leading-relaxed`}>
          {diffs.map((d, i) => {
            if (d.truncated) {
              return (
                <div
                  key={i}
                  className="flex px-2 py-1 text-xs text-muted-foreground"
                  data-testid="diff-truncated-notice"
                >
                  {d.text}
                </div>
              );
            }
            return (
              <div
                key={i}
                className={`flex ${lineClass(d.type)} ${d.type !== 'same' ? 'font-medium' : ''}`}
              >
                <span
                  className="min-w-10 shrink-0 select-none pr-1 text-right text-muted-foreground"
                  data-testid="diff-old-line-number"
                >
                  {d.oldLineNumber ?? ''}
                </span>
                <span
                  className="min-w-10 shrink-0 select-none pr-1 text-right text-muted-foreground"
                  data-testid="diff-new-line-number"
                >
                  {d.newLineNumber ?? ''}
                </span>
                <span className="w-4 shrink-0 select-none text-center">
                  {prefix(d.type)}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-all px-1">
                  <HighlightedLine text={d.text || ' '} language={language} />
                </span>
              </div>
            );
          })}
        </pre>
      </div>
    </div>
  );
}
