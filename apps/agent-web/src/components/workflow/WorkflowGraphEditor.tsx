import { useMutation, useQuery } from '@apollo/client/react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectPopup,
  SelectItem,
  SelectItemText,
} from '@/components/ui/select'
import { GET_ACP_SERVER_OPTIONS } from '@/graphql/queries'
import { REFRESH_ACP_SERVER_OPTIONS } from '@/graphql/mutations'
import type {
  GetAcpServerOptionsQuery,
  RefreshAcpServerOptionsMutation,
} from '@/graphql/types'
import type { WorkflowNodeType } from '@/graphql/workflow'
import {
  createEmptyNode,
  type EditableNode,
  type AgentConfigForm,
} from './template-validation'
import { Plus, Trash2, ChevronDown, ChevronRight, GripVertical } from 'lucide-react'

const NODE_TYPE_LABELS: Record<WorkflowNodeType, string> = {
  HUMAN: '人类',
  AI: 'AI',
  FLAG: '旗帜',
}

const NODE_TYPE_ORDER: WorkflowNodeType[] = ['HUMAN', 'AI', 'FLAG']

/** 下拉「留空」哨兵值（Select 不接受空字符串） */
const EMPTY_OPTION_VALUE = '__default__'

/** 只读流程图预览：按阶段分组静态渲染，按 sortOrder 排序 */
function FlowPreview({ nodes }: { nodes: EditableNode[] }) {
  const stages: string[] = []
  for (const node of nodes) {
    const stage = node.stage.trim() || '未命名阶段'
    if (!stages.includes(stage)) stages.push(stage)
  }

  // 按 sortOrder 排序节点
  const sortedNodes = [...nodes].sort((a, b) => {
    const orderA = a.sortOrder ?? Infinity
    const orderB = b.sortOrder ?? Infinity
    return orderA - orderB
  })

  return (
    <div className="rounded-lg border bg-muted/30 p-3" data-testid="flow-preview">
      <div className="mb-2 text-xs font-medium text-muted-foreground">流程预览（只读）</div>
      <div className="space-y-3">
        {stages.map((stage) => (
          <div key={stage}>
            <div className="mb-1 text-xs font-semibold text-foreground">{stage}</div>
            <div className="flex flex-wrap gap-1.5">
              {sortedNodes
                .filter((n) => (n.stage.trim() || '未命名阶段') === stage)
                .map((n, i) => (
                  <Badge key={`${n.nodeKey}-${i}`} variant="secondary">
                    {NODE_TYPE_LABELS[n.type]} · {n.name || n.nodeKey || '未命名'}
                  </Badge>
                ))}
            </div>
          </div>
        ))}
      </div>
      {nodes.some((n) => n.dependsOn.length > 0) && (
        <div className="mt-3 space-y-0.5 border-t pt-2 text-xs text-muted-foreground">
          {nodes.flatMap((n) =>
            n.dependsOn.map((dep) => (
              <div key={`${dep}->${n.nodeKey}`}>
                {dep || '?'} → {n.nodeKey || '?'}
              </div>
            )),
          )}
        </div>
      )}
    </div>
  )
}

/** Mode/模型字段：选中 Harness 工具后由 controller 拉起空实例探测可选选项。 */
function AgentOptionField({
  label,
  ariaLabel,
  value,
  options,
  probing,
  disabled,
  onChange,
}: {
  label: string
  ariaLabel: string
  value: string
  options: { id: string; name: string }[]
  probing: boolean
  disabled: boolean
  onChange: (v: string) => void
}) {
  if (options.length === 0) {
    return (
      <div className="space-y-1.5">
        <Label>{label}</Label>
        <Input
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="留空则由会话内切换"
          disabled={disabled}
        />
        {probing && <p className="text-xs text-muted-foreground">正在拉起空实例探测可选选项…</p>}
      </div>
    )
  }

  const known = options.some((o) => o.id === value)
  const displayName =
    value === '' ? '留空（默认）' : (options.find((o) => o.id === value)?.name ?? value)
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select
        value={value || EMPTY_OPTION_VALUE}
        onValueChange={(v) => v && onChange(v === EMPTY_OPTION_VALUE ? '' : v)}
      >
        <SelectTrigger aria-label={ariaLabel} disabled={disabled}>
          <SelectValue>{displayName}</SelectValue>
          <SelectIcon />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={EMPTY_OPTION_VALUE}>
            <SelectItemText>留空（默认）</SelectItemText>
          </SelectItem>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              <SelectItemText>{o.name}</SelectItemText>
            </SelectItem>
          ))}
          {value && !known && (
            <SelectItem value={value}>
              <SelectItemText>{value}（当前值）</SelectItemText>
            </SelectItem>
          )}
        </SelectPopup>
      </Select>
    </div>
  )
}

/** 单个 AI 节点的 Mode/模型字段组：按所选工具独立发起选项探测 */
function AgentNodeOptionFields({
  controllerId,
  nodeName,
  config,
  disabled,
  onChange,
}: {
  controllerId: string
  nodeName: string
  config: AgentConfigForm
  disabled: boolean
  onChange: (patch: Partial<AgentConfigForm>) => void
}) {
  const { data, loading, refetch } = useQuery<GetAcpServerOptionsQuery>(GET_ACP_SERVER_OPTIONS, {
    variables: { controllerId, acpServerType: config.acpServerType },
    skip: !controllerId || !config.acpServerType,
  })
  const [refreshOptions, { loading: refreshing } = { loading: false }] =
    useMutation<RefreshAcpServerOptionsMutation>(REFRESH_ACP_SERVER_OPTIONS)
  const probing = Boolean(config.acpServerType) && (loading || refreshing)
  const modes = data?.acpServerOptions?.modes ?? []
  const models = data?.acpServerOptions?.models ?? []

  // 主动刷新：服务端清缓存重探测后回读同一份 acpServerOptions，与新建会话对话框保持一致
  const handleRefresh = async () => {
    if (!controllerId || !config.acpServerType || refreshing) return
    try {
      await refreshOptions({
        variables: { controllerId, acpServerType: config.acpServerType },
      })
      await refetch()
      toast.success('选项已刷新')
    } catch {
      toast.error('刷新失败，可重试')
    }
  }

  return (
    <>
      <AgentOptionField
        label="Mode（可选）"
        ariaLabel={`${nodeName} Mode`}
        value={config.modeId}
        options={modes}
        probing={probing}
        disabled={disabled}
        onChange={(v) => onChange({ modeId: v })}
      />
      <AgentOptionField
        label="模型（可选）"
        ariaLabel={`${nodeName} 模型`}
        value={config.modelId}
        options={models}
        probing={probing}
        disabled={disabled}
        onChange={(v) => onChange({ modelId: v })}
      />
      <div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          aria-label={`${nodeName} 刷新选项`}
          disabled={disabled || !config.acpServerType || refreshing}
          onClick={() => { void handleRefresh() }}
        >
          {refreshing ? '刷新中...' : '刷新选项'}
        </Button>
      </div>
    </>
  )
}

/** 可排序的节点项组件 */
function SortableNodeItem({
  node,
  index,
  isCollapsed,
  readOnly,
  showAgentConfig,
  availableServerTypes,
  controllerId,
  nodes,
  onToggleCollapse,
  onRemove,
  onUpdate,
  onUpdateAgentConfig,
  onToggleDependsOn,
}: {
  node: EditableNode
  index: number
  isCollapsed: boolean
  readOnly: boolean
  showAgentConfig: boolean
  availableServerTypes: string[]
  controllerId: string
  nodes: EditableNode[]
  onToggleCollapse: (index: number) => void
  onRemove: (index: number) => void
  onUpdate: (index: number, patch: Partial<EditableNode>) => void
  onUpdateAgentConfig: (index: number, patch: Partial<AgentConfigForm>) => void
  onToggleDependsOn: (index: number, depKey: string, checked: boolean) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: node.nodeKey || `node-${index}` })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : 0,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="space-y-3 rounded-lg border p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {!readOnly && (
            <button
              type="button"
              className="cursor-grab active:cursor-grabbing"
              aria-label={`拖动排序 ${index + 1}`}
              {...attributes}
              {...listeners}
            >
              <GripVertical className="size-4 text-muted-foreground" />
            </button>
          )}
          <Button
            size="xs"
            variant="ghost"
            aria-label={isCollapsed ? `展开节点 ${index + 1}` : `折叠节点 ${index + 1}`}
            onClick={() => onToggleCollapse(index)}
            disabled={readOnly}
          >
            {isCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
          </Button>
          {NODE_TYPE_ORDER.map((t) => (
            <Button
              key={t}
              size="xs"
              variant={node.type === t ? 'default' : 'outline'}
              aria-pressed={node.type === t}
              disabled={readOnly}
              onClick={() => onUpdate(index, { type: t, linkUpstreamPullRequest: t === 'HUMAN' ? node.linkUpstreamPullRequest : false })}
            >
              {NODE_TYPE_LABELS[t]}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{node.name.trim() || node.nodeKey.trim() || `节点 ${index + 1}`}</span>
          {!readOnly && nodes.length > 1 && (
            <Button
              size="xs"
              variant="ghost"
              aria-label={`删除节点 ${index + 1}`}
              onClick={() => onRemove(index)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {showAgentConfig && node.type === 'AI' && (
        <AgentConfigFields
          nodeName={node.name || node.nodeKey || `节点 ${index + 1}`}
          config={
            node.agentConfig ?? {
              acpServerType: '',
              modeId: '',
              modelId: '',
              initNewWorktree: false,
            }
          }
          availableServerTypes={availableServerTypes}
          controllerId={controllerId}
          readOnly={readOnly}
          onChange={(patch) => onUpdateAgentConfig(index, patch)}
        />
      )}

      {!isCollapsed && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>节点标识</Label>
              <Input
                aria-label={`节点 ${index + 1} 标识`}
                value={node.nodeKey}
                onChange={(e) => onUpdate(index, { nodeKey: e.target.value })}
                placeholder="如: requirement"
                disabled={readOnly}
              />
            </div>
            <div className="space-y-1.5">
              <Label>节点名称</Label>
              <Input
                aria-label={`节点 ${index + 1} 名称`}
                value={node.name}
                onChange={(e) => onUpdate(index, { name: e.target.value })}
                placeholder="如: 产品需求"
                disabled={readOnly}
              />
            </div>
            <div className="space-y-1.5">
              <Label>所属阶段</Label>
              <Input
                aria-label={`节点 ${index + 1} 阶段`}
                value={node.stage}
                onChange={(e) => onUpdate(index, { stage: e.target.value })}
                placeholder="如: 方案阶段"
                disabled={readOnly}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>节点描述</Label>
            <Input
              aria-label={`节点 ${index + 1} 描述`}
              value={node.description}
              onChange={(e) => onUpdate(index, { description: e.target.value })}
              placeholder="可选"
              disabled={readOnly}
            />
          </div>

          {node.type === 'AI' && (
            <>
              <div className="space-y-1.5">
                <Label>提示词（每行一条）</Label>
                <textarea
                  aria-label={`节点 ${index + 1} 提示词`}
                  className="min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                  value={node.promptsText}
                  onChange={(e) => onUpdate(index, { promptsText: e.target.value })}
                  placeholder={'每行一条提示词\n如: 参照项目中的 AGENTS.md 产出技术方案'}
                  disabled={readOnly}
                />
              </div>
              <div className="space-y-1.5">
                <Label>产物标题（每行一条）</Label>
                <textarea
                  aria-label={`节点 ${index + 1} 产物标题`}
                  className="min-h-12 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                  value={node.artifactTitlesText}
                  onChange={(e) => onUpdate(index, { artifactTitlesText: e.target.value })}
                  placeholder={'每行一个产物标题\n如: 产品需求和技术方案'}
                  disabled={readOnly}
                />
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  aria-label={`节点 ${index + 1} Worktree 隔离`}
                  checked={node.requiresWorktree}
                  onCheckedChange={(checked) =>
                    onUpdate(index, { requiresWorktree: checked === true })
                  }
                  disabled={readOnly}
                />
                <Label>该节点会话需要 Worktree 隔离</Label>
              </div>
            </>
          )}

          {node.type === 'HUMAN' && (
            <div className="flex items-center gap-2">
              <Switch
                aria-label={`节点 ${index + 1} 联动上游 Pull Request`}
                checked={node.linkUpstreamPullRequest}
                onCheckedChange={(checked) =>
                  onUpdate(index, { linkUpstreamPullRequest: checked === true })
                }
                disabled={readOnly}
              />
              <Label>联动上游 Pull Request</Label>
            </div>
          )}

          {nodes.filter((_, i) => i !== index).some((n) => n.nodeKey.trim()) && (
            <div className="space-y-1.5">
              <Label>依赖的上游节点</Label>
              <div className="flex flex-wrap gap-3">
                {nodes.map((other, otherIndex) => {
                  const depKey = other.nodeKey.trim()
                  if (otherIndex === index || !depKey) return null
                  const checked = node.dependsOn.includes(depKey)
                  return (
                    <label
                      key={`${otherIndex}-${depKey}`}
                      className="flex items-center gap-1.5 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={checked}
                        disabled={readOnly}
                        onChange={(e) => onToggleDependsOn(index, depKey, e.target.checked)}
                      />
                      {other.name.trim() || depKey}（{depKey}）
                    </label>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
export interface AgentConfigFieldsProps {
  nodeName: string
  config: AgentConfigForm
  availableServerTypes: string[]
  controllerId: string
  readOnly: boolean
  onChange: (patch: Partial<AgentConfigForm>) => void
}

export function AgentConfigFields({
  nodeName,
  config,
  availableServerTypes,
  controllerId,
  readOnly,
  onChange,
}: AgentConfigFieldsProps) {
  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
      <div className="text-sm font-medium">Agent 配置</div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label>Harness 工具</Label>
          <Select
            value={config.acpServerType}
            onValueChange={(v) => v && onChange({ acpServerType: v })}
          >
            <SelectTrigger aria-label={`${nodeName} Harness 工具`} disabled={readOnly}>
              <SelectValue>{config.acpServerType || '选择工具'}</SelectValue>
              <SelectIcon />
            </SelectTrigger>
            <SelectPopup>
              {availableServerTypes.length > 0 ? (
                availableServerTypes.map((t) => (
                  <SelectItem key={t} value={t}>
                    <SelectItemText>{t}</SelectItemText>
                  </SelectItem>
                ))
              ) : config.acpServerType ? (
                <SelectItem value={config.acpServerType}>
                  <SelectItemText>{config.acpServerType}</SelectItemText>
                </SelectItem>
              ) : null}
            </SelectPopup>
          </Select>
          {controllerId && availableServerTypes.length === 0 && (
            <p className="text-xs text-muted-foreground">该 Controller 暂无可用工具</p>
          )}
        </div>
        <AgentNodeOptionFields
          controllerId={controllerId}
          nodeName={nodeName}
          config={config}
          disabled={readOnly}
          onChange={onChange}
        />
      </div>
      <div className="flex items-center gap-2">
        <Switch
          aria-label={`${nodeName} 初始化新 Worktree`}
          checked={config.initNewWorktree}
          onCheckedChange={(checked) => onChange({ initNewWorktree: checked === true })}
          disabled={readOnly}
        />
        <Label>初始化新 Worktree</Label>
      </div>
    </div>
  )
}

interface WorkflowGraphEditorProps {
  nodes: EditableNode[]
  onNodesChange: (nodes: EditableNode[]) => void
  /** 只读查看 */
  readOnly?: boolean
  /** 是否展示 Agent 配置编辑（模板编辑器为 false；已配置/实例化界面为 true） */
  showAgentConfig?: boolean
  /** 可选 acpServerType 列表（已配置/实例化界面由父组件按 controller capabilities 传入） */
  availableServerTypes?: string[]
  /** 用于探测 Mode/模型可选选项的 controllerId */
  controllerId?: string
}

/** 节点图表单组件：增删节点、依赖多选、提示词/产物、阶段、Agent 配置。支持按节点折叠（默认全部折叠）。 */
export default function WorkflowGraphEditor({
  nodes,
  onNodesChange,
  readOnly = false,
  showAgentConfig = false,
  availableServerTypes = [],
  controllerId = '',
}: WorkflowGraphEditorProps) {
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set(nodes.map((_, i) => i)))

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const updateNode = (index: number, patch: Partial<EditableNode>) => {
    onNodesChange(nodes.map((n, i) => (i === index ? { ...n, ...patch } : n)))
  }

  const updateAgentConfig = (index: number, patch: Partial<AgentConfigForm>) => {
    onNodesChange(
      nodes.map((n, i) =>
        i === index
          ? { ...n, agentConfig: { ...(n.agentConfig ?? { acpServerType: '', modeId: '', modelId: '', initNewWorktree: false }), ...patch } }
          : n,
      ),
    )
  }

  const removeNode = (index: number) => {
    const removed = nodes[index]
    onNodesChange(
      nodes
        .filter((_, i) => i !== index)
        .map((n) => ({
          ...n,
          dependsOn: n.dependsOn.filter((dep) => dep !== removed.nodeKey.trim()),
        })),
    )
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.delete(index)
      return next
    })
  }

  const toggleDependsOn = (index: number, depKey: string, checked: boolean) => {
    onNodesChange(
      nodes.map((n, i) => {
        if (i !== index) return n
        return {
          ...n,
          dependsOn: checked
            ? [...n.dependsOn, depKey]
            : n.dependsOn.filter((d) => d !== depKey),
        }
      }),
    )
  }

  const addNode = () => {
    onNodesChange([...nodes, createEmptyNode('AI')])
    setCollapsed((prev) => new Set(prev).add(nodes.length))
  }

  const toggleCollapse = (index: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = nodes.findIndex((n) => (n.nodeKey || `node-${nodes.indexOf(n)}`) === active.id)
    const newIndex = nodes.findIndex((n) => (n.nodeKey || `node-${nodes.indexOf(n)}`) === over.id)

    if (oldIndex !== -1 && newIndex !== -1) {
      const newNodes = arrayMove(nodes, oldIndex, newIndex)
      // 拖拽结束时重排并写入 sortOrder（0..n-1）
      const sortedNodes = newNodes.map((node, index) => ({
        ...node,
        sortOrder: index,
      }))
      onNodesChange(sortedNodes)
    }
  }

  return (
    <div className="space-y-3">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={nodes.map((n, i) => n.nodeKey || `node-${i}`)} strategy={verticalListSortingStrategy}>
          {nodes.map((node, index) => {
            const isCollapsed = collapsed.has(index)
            return (
              <SortableNodeItem
                key={index}
                node={node}
                index={index}
                isCollapsed={isCollapsed}
                readOnly={readOnly}
                showAgentConfig={showAgentConfig}
                availableServerTypes={availableServerTypes}
                controllerId={controllerId}
                nodes={nodes}
                onToggleCollapse={toggleCollapse}
                onRemove={removeNode}
                onUpdate={updateNode}
                onUpdateAgentConfig={updateAgentConfig}
                onToggleDependsOn={toggleDependsOn}
              />
            )
          })}
        </SortableContext>
      </DndContext>

      {!readOnly && (
        <Button variant="outline" size="sm" onClick={addNode}>
          <Plus className="size-3.5" />
          添加节点
        </Button>
      )}

      <FlowPreview nodes={nodes} />
    </div>
  )
}
