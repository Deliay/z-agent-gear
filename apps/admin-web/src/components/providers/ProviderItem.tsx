import { Checkbox } from '@/components/ui/checkbox'
import ProviderActionMenu from './ProviderActionMenu'
import { maskCredential } from '@/lib/credential'
import type { AdminProviderData, ProviderInputData } from '@/graphql/types'

interface ProviderItemProps {
  provider: AdminProviderData
  selected: boolean
  onSelect: (id: string) => void
  onEdit: (provider: ProviderInputData & { id: string }) => void
  onToggle: (id: string) => void
  onDelete: (id: string) => void
}

export default function ProviderItem({
  provider,
  selected,
  onSelect,
  onEdit,
  onToggle,
  onDelete,
}: ProviderItemProps) {
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border p-4 transition-colors ${
        provider.isEnabled ? '' : 'opacity-60'
      }`}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={() => onSelect(provider.id)}
        aria-label={`选择 ${provider.name}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{provider.name}</span>
          {!provider.isEnabled && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              已禁用
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
          <span>{provider.type}</span>
          <span>{maskCredential(provider.credentialValue)}</span>
          <span>{provider.models.length} 个模型</span>
        </div>
      </div>
      <ProviderActionMenu
        isEnabled={provider.isEnabled}
        onEdit={() => onEdit(provider)}
        onToggle={() => onToggle(provider.id)}
        onDelete={() => onDelete(provider.id)}
      />
    </div>
  )
}
