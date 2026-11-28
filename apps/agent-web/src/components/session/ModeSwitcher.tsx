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
  /** 能力门控：仅「有快照 + 明确 unsupported」时为 true */
  blocked?: boolean;
  blockedReason?: string | null;
}

export default function ModeSwitcher({ currentModeId, modes, status, onSetMode, disabled: disabledProp, blocked, blockedReason }: ModeSwitcherProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const currentMode = modes.find((m) => m.id === currentModeId);
  const disabled = disabledProp || blocked || status !== 'idling' || modes.length === 0;
  const title = blocked
    ? (blockedReason || '当前 Agent 不支持模式切换')
    : disabled
      ? (modes.length === 0 ? '暂无可用模式' : '仅空闲时可用')
      : '切换模式';

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
        title={title}
        className="flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
      >
        <span>{currentMode?.name || '模式'}</span>
        <span className="text-muted-foreground">▾</span>
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
