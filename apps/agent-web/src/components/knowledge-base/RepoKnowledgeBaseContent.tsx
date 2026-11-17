import MarkdownContent from '@/components/session/MarkdownContent';
import type { RepoKnowledgeBaseDocumentData } from '@/graphql/knowledge-base';
import { splitFrontMatter } from '@/lib/front-matter';

/**
 * 仓库知识库文档正文（只读预览专用）。
 *
 * front matter 键值对渲染为键值表格（按原文全部键逐行，含三键以外的自定义键），
 * 正文复用既有 `MarkdownContent`（不侵入会话 Markdown 管线）。
 */
export default function RepoKnowledgeBaseContent({
  document,
}: {
  document: RepoKnowledgeBaseDocumentData;
}) {
  const { frontMatter, body } = splitFrontMatter(document.content);

  return (
    <div className="min-w-0" data-testid="repo-knowledge-base-content">
      {frontMatter.length > 0 && (
        <div className="mb-4 min-w-0 overflow-x-auto">
          <table
            className="w-full border-collapse text-xs"
            data-testid="repo-kb-front-matter-table"
          >
            <tbody>
              {frontMatter.map((entry, index) => (
                <tr key={`${entry.key}-${index}`} className="border-b border-border/60">
                  <th
                    scope="row"
                    className="w-40 min-w-0 px-2 py-1 text-left align-top font-medium text-muted-foreground"
                  >
                    {entry.key}
                  </th>
                  <td className="min-w-0 wrap-anywhere px-2 py-1 align-top">{entry.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="min-w-0 wrap-anywhere text-sm leading-6">
        <MarkdownContent content={body} />
      </div>
    </div>
  );
}
