import { useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { CHANGE_ADMIN_PASSWORD } from '@/graphql/mutations'
import type { ChangeAdminPasswordMutation } from '@/graphql/types'
import { useAuth } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const MIN_PASSWORD_LENGTH = 10

export default function ChangePasswordPage() {
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const { login } = useAuth()

  const [changePassword, { loading }] = useMutation<ChangeAdminPasswordMutation>(
    CHANGE_ADMIN_PASSWORD,
    {
      onCompleted: (data) => {
        const { token, admin } = data.changeAdminPassword
        login(token, admin)
        navigate('/models', { replace: true })
      },
      onError: (err: Error) => {
        setError(err.message)
      },
    },
  )

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`新密码长度至少 ${MIN_PASSWORD_LENGTH} 位`)
      return
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致')
      return
    }
    changePassword({ variables: { oldPassword, newPassword } })
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center text-2xl">修改密码</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">
            首次登录需修改默认密码后才能进入后台。
          </p>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="old-password">当前密码</Label>
              <Input
                id="old-password"
                type="password"
                autoComplete="current-password"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">新密码</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位`}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">确认新密码</Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">{error}</p>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? '提交中…' : '确认修改'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
