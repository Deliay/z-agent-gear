import { useState } from 'react';

interface AgentMode {
  id: string;
  name: string;
  description?: string | null;
}

interface ModeSelectDialogProps {
  open: boolean;
  modes: AgentMode[];
  currentModeId: string | null | undefined;
  loading: boolean;
  onSelect: (modeId: string) => void;
  onClose: () => void;
}

export default function ModeSelectDialog({ open, modes, currentModeId, loading, onSelect, onClose }: ModeSelectDialogProps) {
  const [selectedId, setSelectedId] = useState<string | null>(currentModeId ?? null);

  if (!open) return null;

  const handleConfirm = () => {
    if (selectedId) {
      onSelect(selectedId);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      role="dialog"
      tabIndex={-1}
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div
        className="w-96 rounded-lg bg-popover p-6 shadow-xl"
        role="dialog"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <h2 className="mb-4 text-lg font-semibold text-popover-foreground">Switch Mode</h2>
        <div className="space-y-2">
          {modes.map((mode) => (
            <button
              key={mode.id}
              type="button"
              onClick={() => setSelectedId(mode.id)}
              className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm ${
                selectedId === mode.id
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border hover:bg-accent'
              }`}
            >
              <div>
                <div className="font-medium text-popover-foreground">{mode.name}</div>
                {mode.description && (
                  <div className="mt-0.5 text-xs text-muted-foreground">{mode.description}</div>
                )}
              </div>
              {selectedId === mode.id && <span className="text-primary">✓</span>}
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!selectedId || loading}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
          >
            {loading ? '切换中...' : '确认'}
          </button>
        </div>
      </div>
    </div>
  );
}
