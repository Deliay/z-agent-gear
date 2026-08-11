interface DiffViewProps {
  oldText?: string | null;
  newText: string;
  filePath?: string;
  inline?: boolean;
}

function computeLineDiff(oldLines: string[], newLines: string[]): Array<{ type: 'same' | 'removed' | 'added'; text: string }> {
  const result: Array<{ type: 'same' | 'removed' | 'added'; text: string }> = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < oldLines.length && i < newLines.length) {
      if (oldLines[i] === newLines[i]) {
        result.push({ type: 'same', text: oldLines[i] });
      } else {
        result.push({ type: 'removed', text: oldLines[i] });
        result.push({ type: 'added', text: newLines[i] });
      }
    } else if (i < oldLines.length) {
      result.push({ type: 'removed', text: oldLines[i] });
    } else {
      result.push({ type: 'added', text: newLines[i] });
    }
  }
  return result;
}

export default function DiffView({ oldText, newText, filePath, inline }: DiffViewProps) {
  const isNewFile = oldText == null;
  const oldLines = isNewFile ? [] : (oldText ?? '').split('\n');
  const newLines = newText.split('\n');
  const diffs = computeLineDiff(oldLines, newLines);

  const containerClass = inline
    ? 'rounded border border-border text-xs'
    : 'rounded-lg border border-border text-sm';

  const lineClass = (type: string) => {
    switch (type) {
      case 'removed': return 'bg-destructive/10 text-destructive';
      case 'added': return 'bg-success/10 text-success';
      default: return 'text-foreground';
    }
  };

  const prefix = (type: string) => {
    switch (type) {
      case 'removed': return '−';
      case 'added': return '+';
      default: return ' ';
    }
  };

  return (
    <div className={containerClass}>
      {filePath && (
        <div className="flex items-center justify-between border-b border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">
          <span className="min-w-0 break-all">{filePath}</span>
          {isNewFile && (
            <span className="rounded bg-success/20 px-1.5 py-0.5 text-[10px] font-semibold text-success">
              新建文件
            </span>
          )}
        </div>
      )}
      <div className="overflow-x-auto">
        <pre className={`${inline ? 'max-h-48' : 'max-h-96'} overflow-y-auto p-0 leading-relaxed`}>
          {diffs.map((d, i) => (
            <div
              key={i}
              className={`flex ${lineClass(d.type)} ${d.type !== 'same' ? 'font-medium' : ''}`}
            >
              <span className="w-8 flex-shrink-0 select-none text-right text-muted-foreground">
                {' '}
              </span>
              <span className="w-4 flex-shrink-0 select-none text-center">
                {prefix(d.type)}
              </span>
              <span className="flex-1 whitespace-pre-wrap break-all px-1">
                {d.text || ' '}
              </span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}
