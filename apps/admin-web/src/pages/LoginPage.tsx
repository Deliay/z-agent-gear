import { useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { ADMIN_LOGIN } from '@/graphql/mutations'
import type { AdminLoginMutation } from '@/graphql/types'
import { useAuth } from '@/stores/auth'
import { setAdminApiBase, clearAdminApiBase } from '@/lib/api-base'
import { reloadApp } from '@/lib/runtime'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [serverOpen, setServerOpen] = useState(false)
  const [endpointInput, setEndpointInput] = useState('')
  const [savingEndpoint, setSavingEndpoint] = useState(false)
  const navigate = useNavigate()
  const { login } = useAuth()

  const [doLogin, { loading }] = useMutation<AdminLoginMutation>(ADMIN_LOGIN, {
    onCompleted: (data) => {
      const { token, admin } = data.adminLogin
      login(token, admin)
      if (admin.mustChangePassword) {
        navigate('/change-password', { replace: true })
      } else {
        navigate('/models', { replace: true })
      }
    },
    onError: (err: Error) => {
      setError(err.message)
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    doLogin({ variables: { username, password } })
  }

  const handleSaveEndpoint = async () => {
    if (!endpointInput.trim()) {
      toast.error('请输入服务器地址')
      return
    }
    setSavingEndpoint(true)
    const ok = await setAdminApiBase(endpointInput)
    setSavingEndpoint(false)
    if (ok) {
      toast.success('服务器地址已保存，正在重新加载…')
      reloadApp()
    } else {
      toast.error('无法连接到该服务器，请检查地址是否正确')
    }
  }

  const handleResetEndpoint = () => {
    clearAdminApiBase()
    toast.success('已恢复默认服务器地址，正在重新加载…')
    reloadApp()
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center text-2xl">管理后台登录</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">用户名</Label>
              <Input
                id="username"
                name="username"
                type="text"
                autoComplete="username"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="输入用户名…"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="输入密码…"
                required
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">{error}</p>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? '登录中…' : '登录'}
            </Button>
          </form>

          <div className="mt-4 border-t pt-3">
            <button
              type="button"
              className="text-xs text-muted-foreground underline-offset-4 hover:underline"
              onClick={() => setServerOpen((v) => !v)}
            >
              服务器地址
            </button>
            {serverOpen && (
              <div className="mt-3 space-y-2">
                <div className="space-y-1">
                  <Label htmlFor="admin-endpoint" className="text-xs">服务器地址</Label>
                  <Input
                    id="admin-endpoint"
                    value={endpointInput}
                    onChange={(e) => setEndpointInput(e.target.value)}
                    placeholder="https://admin-api.example.com"
                    spellCheck={false}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleSaveEndpoint}
                    disabled={savingEndpoint}
                  >
                    {savingEndpoint ? '检测中…' : '保存'}
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={handleResetEndpoint}>
                    恢复默认
                  </Button>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
