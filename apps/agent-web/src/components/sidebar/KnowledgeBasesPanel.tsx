import KnowledgeBaseSection from '../knowledge-base/KnowledgeBaseSection';

/** 知识库领域专视图：承载平台托管知识库树与仓库内建知识库只读分区 */
export default function KnowledgeBasesPanel() {
  return (
    <div
      data-testid="context-panel-domain-knowledgeBases"
      className="min-h-0 flex-1 overflow-y-auto p-2"
    >
      <KnowledgeBaseSection embedded expanded onToggle={() => {}} />
    </div>
  );
}
