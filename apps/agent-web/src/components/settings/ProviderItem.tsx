import { Checkbox } from '@/components/ui/checkbox'
import ProviderActionMenu from './ProviderActionMenu'
import { ResourceSourceBadge } from './ResourceSourceBadge'
import { maskCredential } from '@/lib/credential'
import type { ResourceSource } from '@/lib/workspace-source'

interface ProviderItemData {
  id: string
  name: string
  type: string
  endpoint: string
  credentialType: string
  credentialValue: string
  isEnabled: boolean
  models: Array<{ id: string }>
}

interface ProviderItemProps {
  provider: ProviderItemData
  selected: boolean
  onSelect: (id: string) => void
  onEdit: (provider: ProviderItemData) => void
  onToggle: (id: string) => void
  onDelete: (id: string) => void
  /** 当前上下文不可写（全局上下文 developer / 全局工作区资源在普通上下文） */
  readOnly?: boolean
  source?: ResourceSource
}

export default function ProviderItem({
  provider,
  selected,
  onSelect,
  onEdit,
  onToggle,
  onDelete,
  readOnly = false,
  source,
}: ProviderItemProps) {
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border p-4 transition-colors ${
        provider.isEnabled ? '' : 'opacity-60'
      }`}
    >
      <Checkbox
        checked={selected}
        disabled={readOnly}
        onCheckedChange={() => {
          if (!readOnly) onSelect(provider.id)
        }}
        aria-label={`选择 ${provider.name}`}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{provider.name}</span>
          {source && <ResourceSourceBadge source={source} />}
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
      {!readOnly && (
        <ProviderActionMenu
          isEnabled={provider.isEnabled}
          onEdit={() => onEdit(provider)}
          onToggle={() => onToggle(provider.id)}
          onDelete={() => onDelete(provider.id)}
        />
      )}
    </div>
  )
}
