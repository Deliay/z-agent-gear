import { useEffect, useRef, useState } from 'react'
import { gql } from '@apollo/client'
import { useMutation } from '@apollo/client/react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth, type AdminUser } from '@/stores/auth'
import { mapOauthError } from '@/lib/auth-oauth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const ADMIN_EXCHANGE_LOGIN_TICKET = gql`
  mutation AdminExchangeLoginTicket($ticket: String!) {
    adminExchangeLoginTicket(ticket: $ticket) {
      token
      admin {
        id
        username
        mustChangePassword
      }
    }
  }
`

interface ExchangeResult {
  adminExchangeLoginTicket: { token: string; admin: AdminUser }
}

/** 后台 OAuth 回调落地页：ticket 一次性兑换 admin JWT（GETDEL 60s）。 */
export default function LoginCallbackPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { login } = useAuth()
  const ticketRef = useRef(searchParams.get('ticket'))
  const errorRef = useRef(searchParams.get('error'))
  const [message, setMessage] = useState(() => mapOauthError(errorRef.current))

  const [exchange] = useMutation<ExchangeResult>(ADMIN_EXCHANGE_LOGIN_TICKET, {
    onCompleted: (data) => {
      const { token, admin } = data.adminExchangeLoginTicket
      login(token, admin)
      navigate(admin.mustChangePassword ? '/change-password' : '/models', { replace: true })
    },
    onError: () => {
      setMessage('登录票据无效或已过期，请重新登录')
    },
  })

  useEffect(() => {
    navigate('/login/callback', { replace: true })
  }, [navigate])

  useEffect(() => {
    if (errorRef.current) return
    if (!ticketRef.current) {
      setMessage('登录票据缺失，请重新登录')
      return
    }
    exchange({ variables: { ticket: ticketRef.current } })
    // ticket 一次性：仅执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center text-2xl">正在登录…</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-center">
          {message ? (
            <>
              <p role="alert" className="text-sm text-destructive">{message}</p>
              <Button className="w-full" onClick={() => navigate('/login', { replace: true })}>
                返回登录
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">正在完成第三方登录，请稍候…</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
