import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface MarkdownContentProps {
  content: string;
}

export default function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        code(props) {
          const { children, className, ...rest } = props;
          const match = /language-(\w+)/.exec(className || '');
          const codeString = String(children).replace(/\n$/, '');
          if (match) {
            return (
              <SyntaxHighlighter
                style={oneDark}
                language={match[1]}
                PreTag="div"
                className="rounded-md !my-2 overflow-x-auto"
              >
                {codeString}
              </SyntaxHighlighter>
            );
          }
          return (
            <code
              className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono break-all"
              {...rest}
            >
              {children}
            </code>
          );
        },
        p(props) {
          return <p className="!my-1 last:!mb-0" {...props} />;
        },
        ul(props) {
          return <ul className="!my-1 list-disc pl-4" {...props} />;
        },
        ol(props) {
          return <ol className="!my-1 list-decimal pl-4" {...props} />;
        },
        li(props) {
          return <li className="!my-0.5" {...props} />;
        },
        pre(props) {
          return <pre className="!my-0 overflow-x-auto" {...props} />;
        },
        // GFM 表格/长链接无排版兜底（未装 @tailwindcss/typography，prose 类无效），
        // 必须自行约束：表格包横向滚动容器、单元格/链接断词，否则撑破窄面板。
        table(props) {
          return (
            <div className="!my-2 overflow-x-auto">
              <table className="border-collapse text-sm" {...props} />
            </div>
          );
        },
        th(props) {
          return <th className="border border-border px-2 py-1 text-left font-medium break-words" {...props} />;
        },
        td(props) {
          return <td className="border border-border px-2 py-1 break-words" {...props} />;
        },
        a(props) {
          return <a className="break-all text-info underline" target="_blank" rel="noreferrer" {...props} />;
        },
      }}
    >
      {content}
    </Markdown>
  );
}
