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
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const controllers = useMemo(() => data?.controllers ?? [], [data?.controllers]);
  const defaultController = useMemo(
    () => controllers.find((controller) => controller.status === 'online') ?? controllers[0],
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
  }, [open]);

  const closePanel = useCallback(() => {
    setOpen(false);
    setActiveIndex(0);
  }, []);

  const selectItem = useCallback(
    (kind: QuickCreateKind) => {
      if (kind === 'session') {
        closePanel();
        setActiveDialog('session');
        return;
      }
      if (!defaultController) {
        toast.error('暂无可用控制器，请先创建控制器');
        return;
      }
      closePanel();
      setActiveDialog('workflow');
    },
    [closePanel, defaultController],
  );

  const handlePanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
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
            {QUICK_CREATE_ITEMS.map((item, index) => {
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
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            使用 ↑ ↓ 选择，Enter 确认，Esc 关闭（⌘K / Ctrl+K 唤起）
          </p>
        </DialogContent>
      </Dialog>

      {activeDialog === 'session' && (
        <QuickCreateSessionDialog controllers={controllers} onClose={() => setActiveDialog(null)} />
      )}

      {activeDialog === 'workflow' && defaultController && (
        <InstantiateWorkflowDialog
          open
          onOpenChange={(next) => {
            if (!next) setActiveDialog(null);
          }}
          controllerId={defaultController.id}
        />
      )}
    </>
  );
}
