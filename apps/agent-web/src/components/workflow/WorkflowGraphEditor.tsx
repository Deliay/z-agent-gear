import { useQuery } from '@apollo/client/react'
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
import type { GetAcpServerOptionsQuery } from '@/graphql/types'
import type { WorkflowNodeType } from '@/graphql/workflow'
import {
  createEmptyNode,
  type EditableNode,
  type AgentConfigForm,
} from './template-validation'
import { Plus, Trash2 } from 'lucide-react'

const NODE_TYPE_LABELS: Record<WorkflowNodeType, string> = {
  HUMAN: '人类',
  AI: 'AI',
  FLAG: '旗帜',
}

const NODE_TYPE_ORDER: WorkflowNodeType[] = ['HUMAN', 'AI', 'FLAG']

/** 下拉「留空」哨兵值（Select 不接受空字符串） */
const EMPTY_OPTION_VALUE = '__default__'

/** 只读流程图预览：按阶段分组静态渲染 */
function FlowPreview({ nodes }: { nodes: EditableNode[] }) {
  const stages: string[] = []
  for (const node of nodes) {
    const stage = node.stage.trim() || '未命名阶段'
    if (!stages.includes(stage)) stages.push(stage)
  }

  return (
    <div className="rounded-lg border bg-muted/30 p-3" data-testid="flow-preview">
      <div className="mb-2 text-xs font-medium text-muted-foreground">流程预览（只读）</div>
      <div className="space-y-3">
        {stages.map((stage) => (
          <div key={stage}>
            <div className="mb-1 text-xs font-semibold text-foreground">{stage}</div>
            <div className="flex flex-wrap gap-1.5">
              {nodes
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
  const { data, loading } = useQuery<GetAcpServerOptionsQuery>(GET_ACP_SERVER_OPTIONS, {
    variables: { controllerId, acpServerType: config.acpServerType },
    skip: !controllerId || !config.acpServerType,
  })
  const probing = Boolean(config.acpServerType) && loading
  const modes = data?.acpServerOptions.modes ?? []
  const models = data?.acpServerOptions.models ?? []
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
    </>
  )
}

/** 单个 AI 节点的 Agent 配置字段组（acpServerType + Mode/模型 + initNewWorktree） */
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

/** 节点图表单组件：增删节点、依赖多选、提示词/产物、阶段、Agent 配置。 */
export default function WorkflowGraphEditor({
  nodes,
  onNodesChange,
  readOnly = false,
  showAgentConfig = false,
  availableServerTypes = [],
  controllerId = '',
}: WorkflowGraphEditorProps) {
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

  const addNode = () => onNodesChange([...nodes, createEmptyNode('AI')])

  return (
    <div className="space-y-3">
      {nodes.map((node, index) => (
        <div key={index} className="space-y-3 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              {NODE_TYPE_ORDER.map((t) => (
                <Button
                  key={t}
                  size="xs"
                  variant={node.type === t ? 'default' : 'outline'}
                  aria-pressed={node.type === t}
                  disabled={readOnly}
                  onClick={() => updateNode(index, { type: t })}
                >
                  {NODE_TYPE_LABELS[t]}
                </Button>
              ))}
            </div>
            {!readOnly && nodes.length > 1 && (
              <Button
                size="xs"
                variant="ghost"
                aria-label={`删除节点 ${index + 1}`}
                onClick={() => removeNode(index)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>节点标识</Label>
              <Input
                aria-label={`节点 ${index + 1} 标识`}
                value={node.nodeKey}
                onChange={(e) => updateNode(index, { nodeKey: e.target.value })}
                placeholder="如: requirement"
                disabled={readOnly}
              />
            </div>
            <div className="space-y-1.5">
              <Label>节点名称</Label>
              <Input
                aria-label={`节点 ${index + 1} 名称`}
                value={node.name}
                onChange={(e) => updateNode(index, { name: e.target.value })}
                placeholder="如: 产品需求"
                disabled={readOnly}
              />
            </div>
            <div className="space-y-1.5">
              <Label>所属阶段</Label>
              <Input
                aria-label={`节点 ${index + 1} 阶段`}
                value={node.stage}
                onChange={(e) => updateNode(index, { stage: e.target.value })}
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
              onChange={(e) => updateNode(index, { description: e.target.value })}
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
                  onChange={(e) => updateNode(index, { promptsText: e.target.value })}
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
                  onChange={(e) => updateNode(index, { artifactTitlesText: e.target.value })}
                  placeholder={'每行一个产物标题\n如: 产品需求和技术方案'}
                  disabled={readOnly}
                />
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  aria-label={`节点 ${index + 1} Worktree 隔离`}
                  checked={node.requiresWorktree}
                  onCheckedChange={(checked) =>
                    updateNode(index, { requiresWorktree: checked === true })
                  }
                  disabled={readOnly}
                />
                <Label>该节点会话需要 Worktree 隔离</Label>
              </div>
            </>
          )}

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
              onChange={(patch) => updateAgentConfig(index, patch)}
            />
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
                        onChange={(e) => toggleDependsOn(index, depKey, e.target.checked)}
                      />
                      {other.name.trim() || depKey}（{depKey}）
                    </label>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      ))}

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
