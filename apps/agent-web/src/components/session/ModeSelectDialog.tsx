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
        className="w-96 rounded-lg bg-white p-6 shadow-xl"
        role="dialog"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        <h2 className="mb-4 text-lg font-semibold">Switch Mode</h2>
        <div className="space-y-2">
          {modes.map((mode) => (
            <button
              key={mode.id}
              type="button"
              onClick={() => setSelectedId(mode.id)}
              className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm ${
                selectedId === mode.id
                  ? 'border-blue-500 bg-blue-50 text-blue-700'
                  : 'border-gray-200 hover:bg-gray-50'
              }`}
            >
              <div>
                <div className="font-medium">{mode.name}</div>
                {mode.description && (
                  <div className="mt-0.5 text-xs text-gray-500">{mode.description}</div>
                )}
              </div>
              {selectedId === mode.id && <span className="text-blue-600">✓</span>}
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!selectedId || loading}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:text-gray-500"
          >
            {loading ? 'Switching...' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
