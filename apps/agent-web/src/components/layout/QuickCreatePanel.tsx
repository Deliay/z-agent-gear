import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { GitBranch, MessageSquarePlus } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import NewSessionDialog from '../session/NewSessionDialog';
import InstantiateWorkflowDialog from '../workflow/InstantiateWorkflowDialog';
import { useHomeOverview } from '../../stores/homeOverview';
import { useCreateSession } from '../../hooks/useCreateSession';

type QuickCreateKind = 'session' | 'workflow';

/** 仅在选择「快速拉起会话」后挂载，避免面板常驻引入提交链路副作用 */
function QuickCreateSessionDialog({
  controllers,
  onClose,
}: {
  controllers: ComponentProps<typeof NewSessionDialog>['controllers'];
  onClose: () => void;
}) {
  const submitCreateSession = useCreateSession();
  return (
    <NewSessionDialog
      controllers={controllers}
      onClose={onClose}
      onCreate={async (...args) => {
        const sessionId = await submitCreateSession(...args);
        if (sessionId) onClose();
      }}
    />
  );
}

interface QuickCreateItem {
  kind: QuickCreateKind;
  label: string;
  description: string;
  icon: typeof MessageSquarePlus;
}

const QUICK_CREATE_ITEMS: QuickCreateItem[] = [
  {
    kind: 'session',
    label: '快速拉起会话',
    description: '选择控制器、工作区与 Harness 后开始对话',
    icon: MessageSquarePlus,
  },
  {
    kind: 'workflow',
    label: '实例化工作流',
    description: '从已配置工作流 / 模板 / 空白图开始编排',
    icon: GitBranch,
  },
];

/**
 * ⌘K / Ctrl+K 全局快速新建面板（D6）。
 *
 * - 仅承载「快速拉起会话 / 实例化工作流」两个入口，点击后打开既有
 *   `NewSessionDialog` / `InstantiateWorkflowDialog`，复用既有提交链路与参数映射。
 * - 面板自身**不发任何查询**（控制器来自 MainLayout 统一下发的 `homeOverview`），
 *   打开对话框后才触发既有查询（性能不变量 D9）。
 */
export default function QuickCreatePanel() {
  const { data } = useHomeOverview();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [activeDialog, setActiveDialog] = useState<QuickCreateKind | null>(null);
  const [workflowControllerId, setWorkflowControllerId] = useState<string | null>(null);
  const [pickingController, setPickingController] = useState(false);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const controllers = useMemo(() => data?.controllers ?? [], [data?.controllers]);
  // 不可回退口径（F12）：工作区/控制器仅展示在线可用，离线控制器不得被回退选中
  const onlineControllers = useMemo(
    () => controllers.filter((controller) => controller.status === 'online'),
    [controllers],
  );

  // 全局快捷键：⌘K / Ctrl+K 唤起，再按一次关闭
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((prev) => !prev);
        setActiveIndex(0);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 打开时把焦点移入第一项，保证键盘可达
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open, pickingController]);

  const closePanel = useCallback(() => {
    setOpen(false);
    setActiveIndex(0);
    setPickingController(false);
  }, []);

  const selectItem = useCallback(
    (kind: QuickCreateKind) => {
      if (kind === 'session') {
        closePanel();
        setActiveDialog('session');
        return;
      }
      if (onlineControllers.length === 0) {
        toast.error('暂无在线可用控制器，请先启动控制器');
        return;
      }
      if (onlineControllers.length === 1) {
        setWorkflowControllerId(onlineControllers[0].id);
        closePanel();
        setActiveDialog('workflow');
        return;
      }
      // 多控制器：先在面板内显式选择目标控制器，避免实例化到错误主机
      setPickingController(true);
      setActiveIndex(0);
    },
    [closePanel, onlineControllers],
  );

  const selectWorkflowController = useCallback(
    (controllerId: string) => {
      setWorkflowControllerId(controllerId);
      closePanel();
      setActiveDialog('workflow');
    },
    [closePanel],
  );

  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (pickingController) {
        setPickingController(false);
        setActiveIndex(0);
      } else {
        closePanel();
      }
      return;
    }
    if (pickingController) {
      const total = onlineControllers.length;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((prev) => (prev + 1) % total);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((prev) => (prev - 1 + total) % total);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const target = onlineControllers[activeIndex];
        if (target) selectWorkflowController(target.id);
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((prev) => {
        const next = (prev + 1) % QUICK_CREATE_ITEMS.length;
        itemRefs.current[next]?.focus();
        return next;
      });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((prev) => {
        const next = (prev - 1 + QUICK_CREATE_ITEMS.length) % QUICK_CREATE_ITEMS.length;
        itemRefs.current[next]?.focus();
        return next;
      });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      selectItem(QUICK_CREATE_ITEMS[activeIndex].kind);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : closePanel())}>
        <DialogContent data-testid="quick-create-panel" className="min-w-0 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>快速新建</DialogTitle>
          </DialogHeader>
          <div
            role="listbox"
            aria-label="快速新建操作"
            className="space-y-1"
            onKeyDown={handlePanelKeyDown}
          >
            {pickingController ? (
              onlineControllers.map((controller, index) => (
                <button
                  key={controller.id}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  data-testid={`quick-create-controller-${controller.id}`}
                  className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    index === activeIndex
                      ? 'border-ring/40 bg-accent text-foreground'
                      : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => selectWorkflowController(controller.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">{controller.name}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">在线</span>
                  </span>
                </button>
              ))
            ) : (
              QUICK_CREATE_ITEMS.map((item, index) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.kind}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  data-testid={`quick-create-${item.kind}`}
                  className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    index === activeIndex
                      ? 'border-ring/40 bg-accent text-foreground'
                      : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => selectItem(item.kind)}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">{item.label}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{item.description}</span>
                  </span>
                  <kbd className="hidden shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground sm:block">
                    {index === 0 ? '↵' : '↵'}
                  </kbd>
                  </button>
                );
              })
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {pickingController
              ? '选择实例化目标控制器（仅在线可用），Esc 返回'
              : '使用 ↑ ↓ 选择，Enter 确认，Esc 关闭（⌘K / Ctrl+K 唤起）'}
          </p>
        </DialogContent>
      </Dialog>

      {activeDialog === 'session' && (
        <QuickCreateSessionDialog controllers={controllers} onClose={() => setActiveDialog(null)} />
      )}

      {activeDialog === 'workflow' && workflowControllerId && (
        <InstantiateWorkflowDialog
          open
          onOpenChange={(next) => {
            if (!next) setActiveDialog(null);
          }}
          controllerId={workflowControllerId}
        />
      )}
    </>
  );
}
