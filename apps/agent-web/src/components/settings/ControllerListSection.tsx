import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { gql } from '@apollo/client'
import type { GetControllerKeysQuery, GetControllersQuery, CreateControllerKeyMutation, RegenerateControllerKeyMutation } from '@/graphql/types'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
const GET_CONTROLLER_KEYS = gql`
  query GetControllerKeys {
    controllerKeys {
      id
      name
      type
      keyPrefix
      status
      rawKey
      lastUsedAt
      createdAt
      updatedAt
    }
  }
`

const GET_CONTROLLERS = gql`
  query GetControllers {
    controllers {
      id
      name
      hostname
      type
      status
      keyId
      version
      lastHeartbeatAt
      createdAt
      updatedAt
    }
  }
`

const CREATE_KEY = gql`
  mutation CreateControllerKey($input: CreateKeyInput!) {
    createControllerKey(input: $input) {
      key { id name type keyPrefix status createdAt }
      rawKey
    }
  }
`

const UNBIND_CONTROLLER = gql`
  mutation UnbindController($id: ID!) {
    unbindController(id: $id)
  }
`

const RENAME_CONTROLLER = gql`
  mutation RenameController($input: RenameInput!) {
    renameController(input: $input) {
      id
      name
    }
  }
`

const REGENERATE_CONTROLLER_KEY = gql`
  mutation RegenerateControllerKey($input: RegenerateControllerKeyInput!) {
    regenerateControllerKey(input: $input) {
      key {
        id
        name
        type
        keyPrefix
        status
        rawKey
        lastUsedAt
        createdAt
        updatedAt
      }
      rawKey
    }
  }
`

const POLL_INTERVAL = 15_000

function autoKeyName(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `Key-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

interface ControllerListSectionProps {
  onNavigateToConfig?: (controllerId: string) => void;
}

export default function ControllerListSection({ onNavigateToConfig }: ControllerListSectionProps) {
  const { data: keyData, loading: keysLoading, refetch: refetchKeys } = useQuery<GetControllerKeysQuery>(GET_CONTROLLER_KEYS)
  const { data: controllerData, loading: controllersLoading, refetch: refetchControllers } = useQuery<GetControllersQuery>(GET_CONTROLLERS, {
    pollInterval: POLL_INTERVAL,
  })

  const [createKey] = useMutation<CreateControllerKeyMutation>(CREATE_KEY)
  const [unbindController] = useMutation(UNBIND_CONTROLLER)
  const [renameController] = useMutation(RENAME_CONTROLLER)
  const [regenerateControllerKey] = useMutation<RegenerateControllerKeyMutation>(REGENERATE_CONTROLLER_KEY)

  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmUnbind, setConfirmUnbind] = useState<{ id: string; name: string } | null>(null)
  const [confirmRegenerate, setConfirmRegenerate] = useState<{ id: string; name: string } | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [regeneratedKey, setRegeneratedKey] = useState<{ controllerId: string; rawKey: string } | null>(null)

  const keys = keyData?.controllerKeys ?? []
  const controllers = controllerData?.controllers ?? []

  const controllerByKeyId = new Map(controllers.map((c) => [c.keyId, c]))

  const unboundKeys = keys.filter((k) => !controllerByKeyId.has(k.id) && k.rawKey)
  const boundControllers = controllers

  const handleGenerateKey = async () => {
    await createKey({
      variables: { input: { name: autoKeyName(), type: 'local' } },
    })
    refetchKeys()
  }

  const handleCopyKey = async (keyId: string, rawKey: string) => {
    await navigator.clipboard.writeText(rawKey)
    setCopiedId(keyId)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const handleUnbind = async (id: string) => {
    await unbindController({ variables: { id } })
    refetchKeys()
    refetchControllers()
    setConfirmUnbind(null)
  }

  const handleRename = async () => {
    if (!renameTarget || !renameValue.trim()) return
    await renameController({ variables: { input: { id: renameTarget.id, name: renameValue.trim() } } })
    refetchControllers()
    setRenameTarget(null)
    setRenameValue('')
  }

  const handleRegenerate = async () => {
    if (!confirmRegenerate) return
    const { data } = await regenerateControllerKey({
      variables: { input: { controllerId: confirmRegenerate.id } },
    })
    if (data?.regenerateControllerKey) {
      setRegeneratedKey({
        controllerId: confirmRegenerate.id,
        rawKey: data.regenerateControllerKey.rawKey,
      })
      await navigator.clipboard.writeText(data.regenerateControllerKey.rawKey)
    }
    refetchKeys()
    refetchControllers()
    setConfirmRegenerate(null)
  }

  const handleCopyRegeneratedKey = async () => {
    if (!regeneratedKey) return
    await navigator.clipboard.writeText(regeneratedKey.rawKey)
  }

  const loading = keysLoading || controllersLoading

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-foreground">控制器管理</h3>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>控制器</CardTitle>
          <Button size="sm" onClick={handleGenerateKey}>
            生成 Key
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-sm text-muted-foreground">加载中...</div>
          ) : unboundKeys.length === 0 && boundControllers.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              暂无控制器，点击「生成 Key」开始配置
            </div>
          ) : (
            <div className="space-y-2">
              {unboundKeys.map((key) => (
                <div key={key.id} className="flex items-center gap-3 rounded-lg border border-dashed p-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{key.name}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {key.type}
                      </span>
                      <span className="rounded bg-warning/15 px-1.5 py-0.5 text-xs text-warning">
                        等待连接
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <code className="break-all font-mono text-sm text-muted-foreground">{key.rawKey}</code>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs shrink-0"
                        onClick={() => key.rawKey && handleCopyKey(key.id, key.rawKey)}
                      >
                        {copiedId === key.id ? '已复制' : '复制'}
                      </Button>
                    </div>
                  </div>
                </div>
              ))}

              {boundControllers.map((ctrl: { id: string; name: string; hostname: string; type: string; status: string; keyId: string; version: string; lastHeartbeatAt: string | null }) => (
                <div key={ctrl.id} className="flex items-center gap-3 rounded-lg border p-4">
                  <div className={`h-2 w-2 rounded-full ${ctrl.status === 'online' ? 'bg-success' : 'bg-muted-foreground'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{ctrl.name || ctrl.hostname}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {ctrl.type}
                      </span>
                      <span className={`rounded px-1.5 py-0.5 text-xs ${
                        ctrl.status === 'online' ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'
                      }`}>
                        {ctrl.status === 'online' ? '在线' : '离线'}
                      </span>
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      <span>{ctrl.hostname}</span>
                      <span className="ml-2">v{ctrl.version}</span>
                      {ctrl.lastHeartbeatAt && (
                        <span className="ml-2">最后心跳 {new Date(ctrl.lastHeartbeatAt).toLocaleTimeString()}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => onNavigateToConfig?.(ctrl.id)}>
                      配置
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setRenameTarget({ id: ctrl.id, name: ctrl.name || ctrl.hostname })}>
                      重命名
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmRegenerate({ id: ctrl.id, name: ctrl.name || ctrl.hostname })}>
                      重新生成Key
                    </Button>
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmUnbind({ id: ctrl.id, name: ctrl.name || ctrl.hostname })}>
                      解绑
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!renameTarget} onOpenChange={() => setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名</DialogTitle>
          </DialogHeader>
          <input
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRename()}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>取消</Button>
            <Button onClick={handleRename}>确认</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmUnbind} onOpenChange={() => setConfirmUnbind(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>解绑控制器</DialogTitle>
            <DialogDescription>
              确定要解绑控制器「{confirmUnbind?.name}」吗？解绑后 Key 将被永久删除。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmUnbind(null)}>取消</Button>
            <Button variant="destructive" onClick={() => confirmUnbind && handleUnbind(confirmUnbind.id)}>
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmRegenerate} onOpenChange={() => setConfirmRegenerate(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重新生成Key</DialogTitle>
            <DialogDescription>
              重新生成key后，旧key将立即失效，控制器需要使用新key重新连接。是否继续？
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            控制器: {confirmRegenerate?.name}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRegenerate(null)}>取消</Button>
            <Button onClick={handleRegenerate}>确认</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!regeneratedKey} onOpenChange={() => setRegeneratedKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新Key已生成</DialogTitle>
            <DialogDescription>
              新Key已生成并复制到剪贴板，请妥善保存。
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border bg-muted p-3">
            <code className="break-all font-mono text-sm">{regeneratedKey?.rawKey}</code>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRegeneratedKey(null)}>关闭</Button>
            <Button onClick={handleCopyRegeneratedKey}>复制Key</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </section>
  )
}
