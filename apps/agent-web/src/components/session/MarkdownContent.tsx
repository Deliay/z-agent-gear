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
                className="rounded-md !my-2"
              >
                {codeString}
              </SyntaxHighlighter>
            );
          }
          return (
            <code
              className="rounded bg-gray-100 px-1.5 py-0.5 text-sm font-mono"
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
          return <pre className="!my-0" {...props} />;
        },
      }}
    >
      {content}
    </Markdown>
  );
}
