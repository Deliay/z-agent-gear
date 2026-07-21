interface TerminalOutputProps {
  output: string;
  maxHeight?: string;
}

function cleanOutput(text: string): string {
  let result = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  result = result.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  result = result.replace(/\x1b\][0-9;]*[^\x1b]*(\x1b\\)|(\x07)/g, '');
  result = result.replace(/\x1b[^a-zA-Z]*[a-zA-Z]/g, '');
  return result;
}

export default function TerminalOutput({ output, maxHeight = '24rem' }: TerminalOutputProps) {
  const cleaned = cleanOutput(output);
  const lines = cleaned.split('\n');

  return (
    <div
      className="overflow-y-auto rounded-lg bg-background p-3 font-mono text-sm leading-relaxed text-success border border-border"
      style={{ maxHeight }}
    >
      {lines.map((line, i) => (
        <div key={i} className="whitespace-pre-wrap break-all">
          {line || <>&nbsp;</>}
        </div>
      ))}
    </div>
  );
}
