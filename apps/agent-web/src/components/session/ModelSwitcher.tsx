import { useState } from 'react';
import type { AgentModelInfoData } from '../../graphql/types';
import { ModelSelectDialog } from './ModelSelectDialog';

interface ModelSwitcherProps {
  currentModelId: string | null | undefined;
  availableModels: AgentModelInfoData[];
  status: string;
  onSetModel: (modelId: string) => Promise<void>;
  disabled?: boolean;
  /** 能力门控：仅「有快照 + 明确 unsupported」时为 true */
  blocked?: boolean;
  blockedReason?: string | null;
}

export function ModelSwitcher({ currentModelId, availableModels, status, onSetModel, disabled: disabledProp, blocked, blockedReason }: ModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const currentModel = currentModelId
    ? availableModels.find((m) => m.id === currentModelId)
    : null;
  const disabled = disabledProp || blocked || status !== 'idling' || availableModels.length === 0;
  const title = blocked
    ? (blockedReason || '当前 Agent 不支持模型切换')
    : availableModels.length === 0
      ? 'No models available'
      : 'Switch model';

  const handleSelect = async (modelId: string) => {
    setLoading(true);
    setOpen(false);
    try {
      await onSetModel(modelId);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled || loading}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        title={title}
      >
        {loading ? 'Switching...' : (currentModel?.name || 'Model')}
        <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <ModelSelectDialog
        open={open}
        models={availableModels}
        currentModelId={currentModelId}
        loading={loading}
        onSelect={handleSelect}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
