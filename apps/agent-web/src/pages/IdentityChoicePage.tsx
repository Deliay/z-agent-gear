import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@apollo/client/react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth, type User } from '@/stores/auth';
import {
  BIND_EXTERNAL_LOGIN_WITH_PASSWORD,
  PROVISION_EXTERNAL_LOGIN,
} from '@/graphql/mutations';
import { GET_PENDING_EXTERNAL_LOGIN_INFO } from '@/graphql/queries';
import type {
  BindExternalLoginWithPasswordMutation,
  GetPendingExternalLoginInfoQuery,
} from '@/graphql/types';
import { mapIdentityChoiceError } from '@/lib/auth-oauth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type AuthPayload = BindExternalLoginWithPasswordMutation['bindExternalLoginWithPassword'];

function payloadFrom(data: unknown): AuthPayload | null {
  const record = data as {
    bindExternalLoginWithPassword?: AuthPayload;
    provisionExternalLogin?: AuthPayload;
  } | null;
  return record?.bindExternalLoginWithPassword ?? record?.provisionExternalLogin ?? null;
}

/**
 * 身份选择页（#510）：外部身份首次登录未绑定时展示。
 *
 * - 读 `pending` 参数并立即从 URL 清除（避免进入浏览器历史）；
 * - 经免登录 `pendingExternalLoginInfo` 展示登录方式与外部帐号名（不消费票据）；
 * - 「绑定已有帐号」验密后绑定并登录；「创建新帐号」走原自动开户。
 */
export default function IdentityChoicePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { login } = useAuth();
  const [pendingToken] = useState(() => searchParams.get('pending') ?? '');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const { data, loading } = useQuery<GetPendingExternalLoginInfoQuery>(
    GET_PENDING_EXTERNAL_LOGIN_INFO,
    {
      variables: { pendingToken },
      skip: !pendingToken,
      fetchPolicy: 'network-only',
    },
  );

  useEffect(() => {
    // 立即清除 URL 中的一次性凭证
    navigate('/login/identity-choice', { replace: true });
  }, [navigate]);

  const handleSuccess = (result: AuthPayload) => {
    login(result.token, result.user as User);
    navigate('/', { replace: true });
  };

  const [bindWithPassword, { loading: binding }] = useMutation(
    BIND_EXTERNAL_LOGIN_WITH_PASSWORD,
    {
      onCompleted: (result: unknown) => {
        const payload = payloadFrom(result);
        if (payload) handleSuccess(payload);
      },
      onError: (err: Error) => setError(mapIdentityChoiceError(err.message)),
    },
  );

  const [provision, { loading: provisioning }] = useMutation(PROVISION_EXTERNAL_LOGIN, {
    onCompleted: (result: unknown) => {
      const payload = payloadFrom(result);
      if (payload) handleSuccess(payload);
    },
    onError: (err: Error) => setError(mapIdentityChoiceError(err.message)),
  });

  const info = data?.pendingExternalLoginInfo ?? null;
  const expired = !pendingToken || (!loading && !info);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    bindWithPassword({ variables: { pendingToken, username, password } });
  };

  const handleProvision = () => {
    setError('');
    provision({ variables: { pendingToken } });
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center text-2xl">选择登录方式</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading && !expired ? (
            <p className="text-center text-sm text-muted-foreground">正在加载登录信息…</p>
          ) : expired ? (
            <>
              <p role="alert" className="text-sm text-destructive">
                登录状态已过期，请重新登录
              </p>
              <Button className="w-full" onClick={() => navigate('/login', { replace: true })}>
                返回登录
              </Button>
            </>
          ) : (
            <>
              <div className="rounded-md bg-muted px-4 py-3 text-sm">
                <p className="text-muted-foreground">第三方登录方式</p>
                <p className="font-medium text-foreground">{info?.providerDisplayName}</p>
                <p className="mt-2 text-muted-foreground">外部帐号</p>
                <p className="font-medium text-foreground">{info?.externalUsername}</p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-3 border-t pt-4">
                <h2 className="text-base font-semibold text-foreground">绑定已有帐号</h2>
                <p className="text-sm text-muted-foreground">
                  输入平台已有帐号的用户名与密码，绑定后可直接登录原帐号。
                </p>
                <div className="space-y-2">
                  <Label htmlFor="identity-username">用户名</Label>
                  <Input
                    id="identity-username"
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
                  <Label htmlFor="identity-password">密码</Label>
                  <Input
                    id="identity-password"
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
                <Button type="submit" className="w-full" disabled={binding || provisioning}>
                  {binding ? '绑定中…' : '绑定并登录'}
                </Button>
              </form>

              <div className="space-y-2 border-t pt-4">
                <h2 className="text-base font-semibold text-foreground">创建新帐号</h2>
                <p className="text-sm text-muted-foreground">
                  使用该第三方身份创建一个全新的平台帐号并登录。
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={handleProvision}
                  disabled={binding || provisioning}
                >
                  {provisioning ? '创建中…' : '创建新帐号'}
                </Button>
              </div>

              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => navigate('/login', { replace: true })}
              >
                返回登录页
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
