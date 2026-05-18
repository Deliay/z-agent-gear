import { useState, useCallback } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { gql } from '@apollo/client'
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
import GenerateKeyDialog from './GenerateKeyDialog'

const GET_CONTROLLER_KEYS = gql`
  query GetControllerKeys {
    controllerKeys {
      id
      name
      type
      keyPrefix
      status
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

const UNBIND_CONTROLLER = gql`
  mutation UnbindController($id: ID!) {
    unbindController(id: $id)
  }
`

const RENAME_KEY = gql`
  mutation RenameControllerKey($input: RenameInput!) {
    renameControllerKey(input: $input) {
      id
      name
    }
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

const POLL_INTERVAL = 15_000

export default function ControllerListSection() {
  const { data: keyData, loading: keysLoading, refetch: refetchKeys } = useQuery(GET_CONTROLLER_KEYS)
  const { data: controllerData, loading: controllersLoading, refetch: refetchControllers } = useQuery(GET_CONTROLLERS, {
    pollInterval: POLL_INTERVAL,
  })

  const [unbindController] = useMutation(UNBIND_CONTROLLER)
  const [renameKey] = useMutation(RENAME_KEY)
  const [renameController] = useMutation(RENAME_CONTROLLER)

  const [generateDialogOpen, setGenerateDialogOpen] = useState(false)
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const [showKeyDialog, setShowKeyDialog] = useState(false)
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string; type: 'key' | 'controller' } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmUnbind, setConfirmUnbind] = useState<{ id: string; name: string } | null>(null)

  const keys = keyData?.controllerKeys ?? []
  const controllers = controllerData?.controllers ?? []

  // Build a map of keyId -> controller for quick lookup
  const controllerByKeyId = new Map(controllers.map((c: { keyId: string;[k: string]: unknown }) => [c.keyId, c]))

  // Unbound keys: keys not bound to any controller
  const unboundKeys = keys.filter((k: { id: string }) => !controllerByKeyId.has(k.id))
  // Bound controllers (keys that have a controller)
  const boundControllers = controllers

  const handleGenerateKey = useCallback((rawKey: string) => {
    setGeneratedKey(rawKey)
    setShowKeyDialog(true)
    refetchKeys()
  }, [refetchKeys])

  const handleUnbind = async (id: string) => {
    await unbindController({ variables: { id } })
    refetchKeys()
    refetchControllers()
    setConfirmUnbind(null)
  }

  const handleRename = async () => {
    if (!renameTarget || !renameValue.trim()) return

    if (renameTarget.type === 'key') {
      await renameKey({ variables: { input: { id: renameTarget.id, name: renameValue.trim() } } })
      refetchKeys()
    } else {
      await renameController({ variables: { input: { id: renameTarget.id, name: renameValue.trim() } } })
      refetchControllers()
    }
    setRenameTarget(null)
    setRenameValue('')
  }

  const openRename = (id: string, name: string, type: 'key' | 'controller') => {
    setRenameTarget({ id, name, type })
    setRenameValue(name)
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
          <Button size="sm" onClick={() => setGenerateDialogOpen(true)}>
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
              {/* Unbound keys — waiting for connection */}
              {unboundKeys.map((key: { id: string; name: string; type: string; keyPrefix: string; createdAt: string }) => (
                <div key={key.id} className="flex items-center gap-3 rounded-lg border border-dashed p-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{key.name}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {key.type}
                      </span>
                      <span className="rounded bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-700">
                        等待连接
                      </span>
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      <code className="font-mono">{key.keyPrefix}...</code>
                      <span className="ml-2">创建于 {new Date(key.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => openRename(key.id, key.name, 'key')}>
                      重命名
                    </Button>
                  </div>
                </div>
              ))}

              {/* Bound controllers */}
              {boundControllers.map((ctrl: { id: string; name: string; hostname: string; type: string; status: string; keyId: string; version: string; lastHeartbeatAt: string | null }) => {
                const key = keys.find((k: { id: string }) => k.id === ctrl.keyId)
                return (
                  <div key={ctrl.id} className="flex items-center gap-3 rounded-lg border p-4">
                    <div className={`h-2 w-2 rounded-full ${ctrl.status === 'online' ? 'bg-green-500' : 'bg-gray-400'}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-foreground">{ctrl.name || ctrl.hostname}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {ctrl.type}
                        </span>
                        <span className={`rounded px-1.5 py-0.5 text-xs ${
                          ctrl.status === 'online' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'
                        }`}>
                          {ctrl.status === 'online' ? '在线' : '离线'}
                        </span>
                      </div>
                      <div className="mt-1 text-sm text-muted-foreground">
                        <span>{ctrl.hostname}</span>
                        <span className="ml-2">v{ctrl.version}</span>
                        {key && (
                          <code className="ml-2 font-mono">{key.keyPrefix}</code>
                        )}
                        {ctrl.lastHeartbeatAt && (
                          <span className="ml-2">最后心跳 {new Date(ctrl.lastHeartbeatAt).toLocaleTimeString()}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openRename(ctrl.id, ctrl.name || ctrl.hostname, 'controller')}>
                        重命名
                      </Button>
                      <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmUnbind({ id: ctrl.id, name: ctrl.name || ctrl.hostname })}>
                        解绑
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <GenerateKeyDialog open={generateDialogOpen} onOpenChange={setGenerateDialogOpen} onGenerated={handleGenerateKey} />

      <Dialog open={showKeyDialog} onOpenChange={setShowKeyDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Key 已生成</DialogTitle>
            <DialogDescription>请立即复制保存，关闭后将不再显示。</DialogDescription>
          </DialogHeader>
          <div className="rounded-lg bg-muted p-4">
            <code className="break-all font-mono text-sm">{generatedKey}</code>
          </div>
          <DialogFooter>
            <Button onClick={() => { navigator.clipboard.writeText(generatedKey || ''); setShowKeyDialog(false); setGeneratedKey(null); }}>
              复制并关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
    </section>
  )
}
