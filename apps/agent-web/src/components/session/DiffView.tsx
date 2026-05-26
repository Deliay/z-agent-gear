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
  const oldLines = (oldText || '').split('\n');
  const newLines = newText.split('\n');
  const diffs = computeLineDiff(oldLines, newLines);

  const containerClass = inline
    ? 'rounded border border-gray-200 text-xs'
    : 'rounded-lg border border-gray-200 text-sm';

  const lineClass = (type: string) => {
    switch (type) {
      case 'removed': return 'bg-red-50 text-red-800';
      case 'added': return 'bg-green-50 text-green-800';
      default: return 'text-gray-700';
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
        <div className="border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-600">
          {filePath}
        </div>
      )}
      <div className="overflow-x-auto">
        <pre className={`${inline ? 'max-h-48' : 'max-h-96'} overflow-y-auto p-0 leading-relaxed`}>
          {diffs.map((d, i) => (
            <div
              key={i}
              className={`flex ${lineClass(d.type)} ${d.type !== 'same' ? 'font-medium' : ''}`}
            >
              <span className="w-8 flex-shrink-0 select-none text-right text-gray-400">
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
