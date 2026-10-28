import type { ReactElement, ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from './markdown/CodeBlock';
import MermaidBlock from './markdown/MermaidBlock';

interface MarkdownContentProps {
  content: string;
}

interface CodeElementProps {
  className?: string;
  children?: ReactNode;
}

export default function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        // 围栏代码块统一由 pre 覆写承接：mermaid 分流到 MermaidBlock，其余（含无语言）走 CodeBlock。
        // 这样避免 code 覆写里再嵌套 pre/高亮容器导致双层横向滚动。
        pre({ children }) {
          const child = Array.isArray(children) ? children[0] : children;
          const codeElement = child as ReactElement<CodeElementProps> | undefined;
          if (!codeElement || typeof codeElement !== 'object' || !codeElement.props) {
            return <pre className="!my-0 overflow-x-auto">{children}</pre>;
          }
          const className = codeElement.props.className ?? '';
          const language = /language-([\w-]+)/.exec(className)?.[1];
          const code = String(codeElement.props.children ?? '').replace(/\n$/, '');
          if (language === 'mermaid') {
            return <MermaidBlock code={code} />;
          }
          return <CodeBlock code={code} language={language} />;
        },
        code({ children, className }) {
          // 保留 language-* class 供 pre 覆写识别；块级代码最终由 pre 覆写消费
          return (
            <code
              className={`${className ? `${className} ` : ''}rounded bg-muted px-1.5 py-0.5 text-sm font-mono break-all`}
            >
              {children}
            </code>
          );
        },
        p(props) {
          // wrap-anywhere（overflow-wrap:anywhere）：缩减 min-content，超长不可断字符串也能换行，
          // 防止撑破窄面板（break-words 不影响 min-content，无效）
          return <p className="!my-1 last:!mb-0 wrap-anywhere" {...props} />;
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
