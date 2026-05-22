import type { AgentModelInfoData } from '../../graphql/types';

interface ModelSelectDialogProps {
  open: boolean;
  models: AgentModelInfoData[];
  currentModelId: string | null | undefined;
  loading: boolean;
  onSelect: (modelId: string) => void;
  onClose: () => void;
}

export function ModelSelectDialog({ open, models, currentModelId, loading, onSelect, onClose }: ModelSelectDialogProps) {
  if (!open) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };
  const handleOverlayKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      tabIndex={-1}
      onClick={handleOverlayClick}
      onKeyDown={handleOverlayKeyDown}
    >
      <div className="w-80 rounded-xl bg-white p-4 shadow-xl">
        <h3 className="mb-3 text-sm font-semibold text-gray-900">Switch Model</h3>
        <div className="mb-3 max-h-60 space-y-1 overflow-y-auto">
          {models.map((model) => (
            <button
              key={model.id}
              type="button"
              onClick={() => onSelect(model.id)}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                model.id === currentModelId
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              <div className="flex flex-col">
                <span>{model.name}</span>
                {model.provider && (
                  <span className="text-xs text-gray-400">{model.provider}</span>
                )}
              </div>
              {model.id === currentModelId && (
                <svg className="h-4 w-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Switching...' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
