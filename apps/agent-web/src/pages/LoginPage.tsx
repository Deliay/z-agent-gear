import { useState } from 'react';
import { gql } from '@apollo/client';
import { useMutation, useQuery } from '@apollo/client/react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth, type User } from '@/stores/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { mapOauthError, oauthAuthorizeUrl } from '@/lib/auth-oauth';

const LOGIN_MUTATION = gql`
  mutation Login($username: String!, $password: String!) {
    login(username: $username, password: $password) {
      token
      user {
        id
        name
        tenant {
          id
          name
          type
          memberCount
        }
      }
    }
  }
`;

const AUTH_PROVIDERS_QUERY = gql`
  query AuthProviders {
    authProviders {
      id
      type
      displayName
    }
  }
`;

interface LoginResult {
  login: { token: string; user: User };
}

interface AuthProviderInfo {
  id: string;
  type: 'oidc' | 'github_oauth';
  displayName: string;
}

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const { login } = useAuth();
  const [searchParams] = useSearchParams();
  const oauthError = mapOauthError(searchParams.get('error'));

  const { data: providerData } = useQuery<{ authProviders: AuthProviderInfo[] }>(
    AUTH_PROVIDERS_QUERY,
    { fetchPolicy: 'cache-and-network' },
  );
  const providers = providerData?.authProviders ?? [];

  const [doLogin, { loading }] = useMutation(LOGIN_MUTATION, {
    onCompleted: (data: unknown) => {
      const result = data as LoginResult;
      login(result.login.token, result.login.user);
      navigate('/', { replace: true });
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    doLogin({ variables: { username, password } });
  };

  const handleOauthLogin = (providerId: string) => {
    window.location.href = oauthAuthorizeUrl(providerId, 'front');
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-center text-2xl">登录</CardTitle>
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
            {(error || oauthError) && (
              <p role="alert" className="text-sm text-destructive">{error || oauthError}</p>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? '登录中…' : '登录'}
            </Button>
          </form>

          {providers.length > 0 && (
            <div className="mt-4 space-y-2 border-t pt-4">
              <p className="text-center text-xs text-muted-foreground">或使用第三方帐号登录</p>
              {providers.map((provider) => (
                <Button
                  key={provider.id}
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => handleOauthLogin(provider.id)}
                >
                  使用 {provider.type === 'github_oauth' ? 'GitHub' : provider.displayName} 登录
                </Button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
