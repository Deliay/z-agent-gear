import { useState, useEffect, useCallback } from 'react'
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

const REVOKE_KEY = gql`
  mutation RevokeControllerKey($id: ID!) {
    revokeControllerKey(id: $id)
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

  const [revokeKey] = useMutation(REVOKE_KEY)
  const [unbindController] = useMutation(UNBIND_CONTROLLER)
  const [renameKey] = useMutation(RENAME_KEY)
  const [renameController] = useMutation(RENAME_CONTROLLER)

  const [generateDialogOpen, setGenerateDialogOpen] = useState(false)
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const [showKeyDialog, setShowKeyDialog] = useState(false)
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string; type: 'key' | 'controller' } | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmTarget, setConfirmTarget] = useState<{ id: string; name: string; type: 'key' | 'controller'; action: 'revoke' | 'unbind' } | null>(null)

  const keys = keyData?.controllerKeys ?? []
  const controllers = controllerData?.controllers ?? []

  const handleGenerateKey = useCallback((rawKey: string) => {
    setGeneratedKey(rawKey)
    setShowKeyDialog(true)
    refetchKeys()
  }, [refetchKeys])

  const handleRevokeKey = async (id: string) => {
    await revokeKey({ variables: { id } })
    refetchKeys()
    refetchControllers()
    setConfirmTarget(null)
  }

  const handleUnbindController = async (id: string) => {
    await unbindController({ variables: { id } })
    refetchKeys()
    refetchControllers()
    setConfirmTarget(null)
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

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-foreground">控制器管理</h3>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>控制器 Key</CardTitle>
          <Button size="sm" onClick={() => setGenerateDialogOpen(true)}>
            生成 Key
          </Button>
        </CardHeader>
        <CardContent>
          {keysLoading ? (
            <div className="text-sm text-muted-foreground">加载中...</div>
          ) : keys.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              暂无 Key，点击「生成 Key」开始配置
            </div>
          ) : (
            <div className="space-y-2">
              {keys.map((key: { id: string; name: string; type: string; keyPrefix: string; status: string; createdAt: string }) => (
                <div key={key.id} className="flex items-center gap-3 rounded-lg border p-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{key.name}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                        {key.type}
                      </span>
                      <span className={`rounded px-1.5 py-0.5 text-xs ${
                        key.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                      }`}>
                        {key.status === 'active' ? '活跃' : '已撤销'}
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
                    {key.status === 'active' && (
                      <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmTarget({ id: key.id, name: key.name, type: 'key', action: 'revoke' })}>
                        撤销
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>控制器列表</CardTitle>
        </CardHeader>
        <CardContent>
          {controllersLoading ? (
            <div className="text-sm text-muted-foreground">加载中...</div>
          ) : controllers.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              暂无控制器连接
            </div>
          ) : (
            <div className="space-y-2">
              {controllers.map((ctrl: { id: string; name: string; hostname: string; type: string; status: string; version: string; lastHeartbeatAt: string | null }) => (
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
                      {ctrl.lastHeartbeatAt && (
                        <span className="ml-2">最后心跳 {new Date(ctrl.lastHeartbeatAt).toLocaleTimeString()}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => openRename(ctrl.id, ctrl.name || ctrl.hostname, 'controller')}>
                      重命名
                    </Button>
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmTarget({ id: ctrl.id, name: ctrl.name || ctrl.hostname, type: 'controller', action: 'unbind' })}>
                      解绑
                    </Button>
                  </div>
                </div>
              ))}
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

      <Dialog open={!!confirmTarget} onOpenChange={() => setConfirmTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmTarget?.action === 'revoke' ? '撤销 Key' : '解绑控制器'}</DialogTitle>
            <DialogDescription>
              {confirmTarget?.action === 'revoke'
                ? `确定要撤销 Key「${confirmTarget?.name}」吗？撤销后使用该 Key 的控制器将被断开。`
                : `确定要解绑控制器「${confirmTarget?.name}」吗？`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmTarget(null)}>取消</Button>
            <Button variant="destructive" onClick={() => {
              if (!confirmTarget) return
              if (confirmTarget.action === 'revoke') {
                handleRevokeKey(confirmTarget.id)
              } else {
                handleUnbindController(confirmTarget.id)
              }
            }}>
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
