import type { AgentModelInfoData } from '../../graphql/types';

interface ModelSelectDialogProps {
  open: boolean;
  models: AgentModelInfoData[];
  currentModelId: string | null | undefined;
  loading: boolean;
  onSelect: (modelId: string) => void;
  onClose: () => void;
}

/** 分组固定顺序（与后端 SOURCE_GROUP 对齐，组内保持 models 原序） */
const GROUP_ORDER = ['平台内置', 'Agent 自带', '自定义', '来源未知'] as const;
const UNKNOWN_GROUP = '来源未知';

interface ModelGroup {
  name: string;
  models: AgentModelInfoData[];
  basis: string[];
}

function groupModels(models: AgentModelInfoData[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const name of GROUP_ORDER) {
    groups.set(name, { name, models: [], basis: [] });
  }

  for (const model of models) {
    const name = model.group && groups.has(model.group) ? model.group : UNKNOWN_GROUP;
    const group = groups.get(name)!;
    group.models.push(model);
    if (model.basis && !group.basis.includes(model.basis)) {
      group.basis.push(model.basis);
    }
  }

  return [...groups.values()].filter((group) => group.models.length > 0);
}

export function ModelSelectDialog({ open, models, currentModelId, loading, onSelect, onClose }: ModelSelectDialogProps) {
  if (!open) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };
  const handleOverlayKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  const groups = groupModels(models);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      tabIndex={-1}
      onClick={handleOverlayClick}
      onKeyDown={handleOverlayKeyDown}
    >
      <div className="w-96 rounded-xl bg-popover p-4 shadow-xl">
        <h3 className="mb-3 text-sm font-semibold text-popover-foreground">Switch Model</h3>
        <div className="mb-3 max-h-72 space-y-3 overflow-y-auto">
          {groups.map((group) => (
            <div key={group.name} data-testid={`model-group-${group.name}`}>
              <div className="mb-1 px-3">
                <p className="text-xs font-semibold text-popover-foreground">
                  {group.name}（{group.models.length}）
                </p>
                {group.basis.length > 0 && (
                  <p className="text-[11px] text-muted-foreground">{group.basis.join('；')}</p>
                )}
              </div>
              <div className="space-y-1">
                {group.models.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => onSelect(model.id)}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      model.id === currentModelId
                        ? 'bg-primary/10 text-primary'
                        : 'text-popover-foreground hover:bg-accent'
                    }`}
                  >
                    <div className="flex flex-col">
                      <span>{model.name}</span>
                      {model.provider && (
                        <span className="text-xs text-muted-foreground">{model.provider}</span>
                      )}
                    </div>
                    {model.id === currentModelId && (
                      <svg className="h-4 w-4 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? 'Switching...' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
