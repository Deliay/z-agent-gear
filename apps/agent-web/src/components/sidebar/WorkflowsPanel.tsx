import { useMemo, useState } from 'react';
import { useQuery } from '@apollo/client/react';
import { Archive, ChevronDown, ChevronRight } from 'lucide-react';
import {
  GET_WORKFLOW_INSTANCES,
  type GetWorkflowInstancesQuery,
  type WorkflowInstanceSummaryData,
} from '@/graphql/workflow';
import WorkflowInstanceCard from '../workflow/WorkflowInstanceCard';
import { sortByUpdatedAtDesc } from '@/lib/sidebar-prefs';

export interface WorkflowsPanelProps {
  workflowInstances: WorkflowInstanceSummaryData[];
  filterQuery: string;
  onClearFilter: () => void;
}

/** 已归档工作流：常驻折叠、无计数、首次点击展开按需懒加载 */
function ArchivedWorkflowGroup() {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const { data, loading, error, refetch } = useQuery<GetWorkflowInstancesQuery>(GET_WORKFLOW_INSTANCES, {
    variables: { archived: true },
    skip: !archivedOpen,
    fetchPolicy: 'cache-and-network',
  });
  const instances = sortByUpdatedAtDesc(data?.workflowInstances ?? []);

  return (
    <div className="shrink-0 border-t border-sidebar-border px-2 py-1.5">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setArchivedOpen((prev) => !prev)}
        aria-expanded={archivedOpen}
      >
        {archivedOpen ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <Archive className="size-3.5 shrink-0" />
        <span>已归档</span>
      </button>
      {archivedOpen && (
        <div className="mt-1 max-h-48 overflow-y-auto pl-2">
          {loading && instances.length === 0 ? (
            <p className="px-2.5 py-1.5 text-xs text-muted-foreground">加载中…</p>
          ) : error ? (
            <div className="px-2.5 py-1.5 text-xs text-muted-foreground">
              加载失败
              <button
                type="button"
                className="ml-2 underline hover:text-foreground"
                onClick={() => void refetch()}
              >
                重试
              </button>
            </div>
          ) : instances.length === 0 ? (
            <p className="px-2.5 py-1.5 text-xs text-muted-foreground">暂无归档</p>
          ) : (
            <ul className="space-y-0.5" data-testid="sidebar-archived-workflow-list">
              {instances.map((instance) => (
                <WorkflowInstanceCard key={instance.id} instance={instance} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** 工作流领域专视图：本地筛选后的活跃工作流实例列表 + 底部按需归档 */
export default function WorkflowsPanel({
  workflowInstances,
  filterQuery,
  onClearFilter,
}: WorkflowsPanelProps) {
  const sortedWorkflows = useMemo(
    () => sortByUpdatedAtDesc(workflowInstances),
    [workflowInstances],
  );

  const normalizedQuery = filterQuery.trim().toLowerCase();
  const filteredWorkflows = useMemo(() => {
    if (!normalizedQuery) return sortedWorkflows;
    return sortedWorkflows.filter((instance) => {
      const name = instance.name.toLowerCase();
      const wsName = (instance.workspace?.name ?? '').toLowerCase();
      return name.includes(normalizedQuery) || wsName.includes(normalizedQuery);
    });
  }, [sortedWorkflows, normalizedQuery]);

  return (
    <div
      data-testid="context-panel-domain-workflows"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {filteredWorkflows.length === 0 && normalizedQuery ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            <p>未找到匹配的工作流</p>
            <button
              type="button"
              onClick={onClearFilter}
              className="mt-2 text-primary hover:underline"
            >
              清空筛选
            </button>
          </div>
        ) : filteredWorkflows.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">暂无活跃工作流实例</p>
        ) : (
          <ul className="space-y-0.5" data-testid="sidebar-workflow-list">
            {filteredWorkflows.map((instance) => (
              <WorkflowInstanceCard key={instance.id} instance={instance} />
            ))}
          </ul>
        )}
      </div>

      <ArchivedWorkflowGroup />
    </div>
  );
}
