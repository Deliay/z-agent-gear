import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { WorkflowInstanceData } from '@/graphql/workflow';
import BlackboardPanel from './BlackboardPanel';
import WorkflowContextPanel from './WorkflowContextPanel';

export interface WorkflowInspectorDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  instance: WorkflowInstanceData;
}

/** 图表模式下的实例资源右侧抽屉：完整展示黑板、垃圾桶、关联 PR 与追加提示词 */
export default function WorkflowInspectorDrawer({
  open,
  onOpenChange,
  instance,
}: WorkflowInspectorDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent data-testid="workflow-inspector-drawer" className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>实例资源</SheetTitle>
          <SheetDescription>
            查看当前工作流实例的黑板产物、垃圾桶、关联 Pull Request 与追加提示词。
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto">
          <BlackboardPanel
            blackboard={instance.blackboard}
            trash={instance.blackboardTrash}
          />
          <WorkflowContextPanel
            additionalPrompts={instance.additionalPrompts}
            pullRequestLinks={instance.pullRequestLinks}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
