import { useState } from 'react';
import ModeSelectDialog from './ModeSelectDialog';

interface AgentMode {
  id: string;
  name: string;
  description?: string | null;
}

interface ModeSwitcherProps {
  currentModeId: string | null | undefined;
  modes: AgentMode[];
  status: string;
  onSetMode: (modeId: string) => Promise<void>;
  disabled?: boolean;
}

export default function ModeSwitcher({ currentModeId, modes, status, onSetMode, disabled: disabledProp }: ModeSwitcherProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const currentMode = modes.find((m) => m.id === currentModeId);
  const disabled = disabledProp || status !== 'idling' || modes.length === 0;

  const handleSelect = async (modeId: string) => {
    if (modeId === currentModeId) {
      setDialogOpen(false);
      return;
    }
    setLoading(true);
    try {
      await onSetMode(modeId);
      setDialogOpen(false);
    } catch {
      // error handled by parent
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        disabled={disabled}
        title={disabled ? (modes.length === 0 ? 'No modes available' : 'Only available when idle') : 'Switch mode'}
        className="flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
      >
        <span>{currentMode?.name || 'Mode'}</span>
        <span className="text-gray-400">▾</span>
      </button>
      <ModeSelectDialog
        open={dialogOpen}
        modes={modes}
        currentModeId={currentModeId}
        loading={loading}
        onSelect={handleSelect}
        onClose={() => setDialogOpen(false)}
      />
    </>
  );
}
