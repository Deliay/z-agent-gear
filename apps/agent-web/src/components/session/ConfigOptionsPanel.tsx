import { useState } from 'react';
import type { SessionConfigOptionData } from '../../graphql/types';

interface ConfigOptionsPanelProps {
  configOptions: SessionConfigOptionData[];
  status: string;
  onSetConfigOption: (configId: string, value: string) => Promise<void>;
}

const UNCATEGORIZED = '其他';

export default function ConfigOptionsPanel({ configOptions, status, onSetConfigOption }: ConfigOptionsPanelProps) {
  const [savingId, setSavingId] = useState<string | null>(null);

  // mode/model 由 ModeSwitcher/ModelSwitcher 负责（bridge 已双轨路由到 setSessionConfigOption），此处过滤避免重复控件
  const visibleOptions = configOptions.filter((opt) => opt.category !== 'mode' && opt.category !== 'model');

  if (visibleOptions.length === 0) return null;

  const groups: Array<{ category: string; options: SessionConfigOptionData[] }> = [];
  for (const opt of visibleOptions) {
    const category = opt.category || UNCATEGORIZED;
    let group = groups.find((g) => g.category === category);
    if (!group) {
      group = { category, options: [] };
      groups.push(group);
    }
    group.options.push(opt);
  }

  const disabled = status !== 'idling';

  const handleSelect = async (opt: SessionConfigOptionData, value: string) => {
    if (!value || value === opt.currentValue) return;
    setSavingId(opt.id);
    try {
      await onSetConfigOption(opt.id, value);
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="mb-2 flex flex-col gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1.5">
      {groups.map((group) => (
        <div key={group.category} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {groups.length > 1 && (
            <span className="w-full text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {group.category}
            </span>
          )}
          {group.options.map((opt) => {
        const currentValue = opt.currentValue ?? '';
        if (opt.type === 'boolean') {
          const checked = currentValue === 'true';
          return (
            <label
              key={opt.id}
              title={opt.description || undefined}
              className="flex cursor-pointer items-center gap-1.5 text-xs text-foreground"
            >
              <button
                type="button"
                role="switch"
                aria-checked={checked}
                disabled={disabled || savingId === opt.id}
                onClick={() => handleSelect(opt, checked ? 'false' : 'true')}
                className={`relative h-4 w-7 rounded-full transition-colors ${
                  checked ? 'bg-primary' : 'bg-muted-foreground/40'
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <span
                  className={`absolute top-0.5 h-3 w-3 rounded-full bg-background transition-transform ${
                    checked ? 'translate-x-3.5' : 'translate-x-0.5'
                  }`}
                />
              </button>
              <span className="font-medium">{opt.name || opt.id.replace(/_/g, ' ')}</span>
            </label>
          );
        }

        if (opt.type === 'select' && opt.options && opt.options.length > 0) {
          return (
            <label
              key={opt.id}
              title={opt.description || undefined}
              className="flex items-center gap-1.5 text-xs text-foreground"
            >
              <span className="font-medium">{opt.name || opt.id.replace(/_/g, ' ')}</span>
              <select
                value={currentValue}
                disabled={disabled || savingId === opt.id}
                onChange={(e) => handleSelect(opt, e.target.value)}
                className="rounded-md border border-input bg-background px-1.5 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="" disabled>
                  Select...
                </option>
                {opt.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.name || o.value}
                  </option>
                ))}
              </select>
            </label>
          );
        }

        if (currentValue) {
          return (
            <span
              key={opt.id}
              title={opt.description || undefined}
              className="text-xs text-foreground"
            >
              <span className="font-medium">{opt.name || opt.id.replace(/_/g, ' ')}:</span>{' '}
              <span className="font-mono break-all">{currentValue}</span>
            </span>
          );
        }

        return null;
          })}
        </div>
      ))}
    </div>
  );
}
