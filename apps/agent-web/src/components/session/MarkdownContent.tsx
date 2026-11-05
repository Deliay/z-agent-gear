import type { ReactElement, ReactNode, ComponentType } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from './markdown/CodeBlock';
import MermaidBlock from './markdown/MermaidBlock';

interface MarkdownContentProps {
  content: string;
  /**
   * 批注模式（MarkdownPreview 专用）：为块级/行内元素注入 `data-sourcepos`
   * （取自 hast node.position），供选择映射源文 offset；预览模式零开销。
   */
  annotate?: boolean;
}

interface CodeElementProps {
  className?: string;
  children?: ReactNode;
}

interface SourceposNode {
  position?: { start: { line: number; column: number }; end: { line: number; column: number } };
}

type CompProps = Record<string, unknown> & { node?: SourceposNode };

const BASE_COMPONENTS = {
  // 围栏代码块统一由 pre 覆写承接：mermaid 分流到 MermaidBlock，其余（含无语言）走 CodeBlock。
  // 这样避免 code 覆写里再嵌套 pre/高亮容器导致双层横向滚动。
  pre({ children }: { children?: ReactNode }) {
    const child = Array.isArray(children) ? children[0] : children;
    const codeElement = child as ReactElement<CodeElementProps> | undefined;
    if (!codeElement || typeof codeElement !== 'object' || !codeElement.props) {
      return <pre className="!my-0 overflow-x-auto">{children}</pre>;
    }
    const className = codeElement.props.className ?? '';
    // 语言名可含 c++ / c# 等符号，不能用 \w 截断（M-4）
    const language = /language-([^\s]+)/.exec(className)?.[1];
    const code = String(codeElement.props.children ?? '').replace(/\n$/, '');
    if (language?.toLowerCase() === 'mermaid') {
      return <MermaidBlock code={code} />;
    }
    return <CodeBlock code={code} language={language} />;
  },
  code({ children, className }: { children?: ReactNode; className?: string }) {
    // 保留 language-* class 供 pre 覆写识别；块级代码最终由 pre 覆写消费
    return (
      <code
        className={`${className ? `${className} ` : ''}rounded bg-muted px-1.5 py-0.5 text-sm font-mono break-all`}
      >
        {children}
      </code>
    );
  },
  p(props: CompProps) {
    // wrap-anywhere（overflow-wrap:anywhere）：缩减 min-content，超长不可断字符串也能换行，
    // 防止撑破窄面板（break-words 不影响 min-content，无效）
    const { node: _node, ...rest } = props;
    return <p className="!my-1 last:!mb-0 wrap-anywhere" {...rest} />;
  },
  ul(props: CompProps) {
    const { node: _node, ...rest } = props;
    return <ul className="!my-1 list-disc pl-4" {...rest} />;
  },
  ol(props: CompProps) {
    const { node: _node, ...rest } = props;
    return <ol className="!my-1 list-decimal pl-4" {...rest} />;
  },
  li(props: CompProps) {
    const { node: _node, ...rest } = props;
    return <li className="!my-0.5" {...rest} />;
  },
  // GFM 表格/长链接无排版兜底（未装 @tailwindcss/typography，prose 类无效），
  // 必须自行约束：表格包横向滚动容器、单元格/链接断词，否则撑破窄面板。
  table(props: CompProps) {
    const { node: _node, ...rest } = props;
    return (
      <div className="!my-2 overflow-x-auto">
        <table className="border-collapse text-sm" {...rest} />
      </div>
    );
  },
  th(props: CompProps) {
    const { node: _node, ...rest } = props;
    return <th className="border border-border px-2 py-1 text-left font-medium break-words" {...rest} />;
  },
  td(props: CompProps) {
    const { node: _node, ...rest } = props;
    return <td className="border border-border px-2 py-1 break-words" {...rest} />;
  },
  a(props: CompProps) {
    const { node: _node, ...rest } = props;
    return <a className="break-all text-info underline" target="_blank" rel="noreferrer" {...rest} />;
  },
  strong(props: CompProps) {
    const { node: _node, ...rest } = props;
    return <strong {...rest} />;
  },
  em(props: CompProps) {
    const { node: _node, ...rest } = props;
    return <em {...rest} />;
  },
};

/** 批注模式包装：从 node.position 计算 `data-sourcepos` 并注入（预览模式不启用，零开销） */
function withSourcepos(Component: ComponentType<CompProps>) {
  return function SourceposWrapped(props: CompProps) {
    const pos = props.node?.position;
    const attr = pos
      ? { 'data-sourcepos': `${pos.start.line}:${pos.start.column}-${pos.end.line}:${pos.end.column}` }
      : {};
    return <Component {...props} {...attr} />;
  };
}

const ANNOTATED_COMPONENTS = Object.fromEntries(
  Object.entries(BASE_COMPONENTS).map(([tag, Component]) => [
    tag,
    withSourcepos(Component as unknown as ComponentType<CompProps>),
  ]),
);

export default function MarkdownContent({ content, annotate = false }: MarkdownContentProps) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={(annotate ? ANNOTATED_COMPONENTS : BASE_COMPONENTS) as never}
    >
      {content}
    </Markdown>
  );
}
