import { useEffect, useState } from 'react';
import { useMutation } from '@apollo/client/react';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { RESPOND_HARNESS_LOGIN } from '../../graphql/mutations';
import { useHarnessLoginDialogState } from '../../stores/harnessLoginDialog';
import { logger } from '../../lib/logger';
import type { RespondHarnessLoginMutation } from '../../graphql/types';

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kimi Code 登录引导弹窗（全站单例，挂在 MainLayout 最高层级）。
 * 关闭弹窗等同取消：调用 respondHarnessLogin(cancel)。
 */
export function HarnessLoginDialog() {
  const { current, close } = useHarnessLoginDialogState();
  const [respondHarnessLogin] = useMutation<RespondHarnessLoginMutation>(RESPOND_HARNESS_LOGIN);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const request = current;

  useEffect(() => {
    setNow(Date.now());
    if (!request?.expiresAt) return;
    const remaining = new Date(request.expiresAt).getTime() - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(remaining, 1000));
    return () => clearTimeout(timer);
  }, [request?.requestId, request?.expiresAt, now]);

  if (!request) return null;

  const expiresAt = new Date(request.expiresAt).getTime();
  const expired = Number.isFinite(expiresAt) && expiresAt <= now;
  const remaining = Number.isFinite(expiresAt) ? expiresAt - now : 0;

  const handleCopy = async (label: string, value: string) => {
    if (await copyText(value)) setCopied(label);
  };

  const handleCancel = async () => {
    if (cancelling) return;
    // 设备码已过期：允许直接关闭弹窗（不发 cancel，避免把已终结请求再改写）；
    // 防止 SSE 漏掉 resolved / worker 被杀时弹窗永久遮挡全站。
    if (expired) {
      close();
      return;
    }
    setCancelling(true);
    try {
      await respondHarnessLogin({ variables: { requestId: request.requestId, action: 'cancel' } });
    } catch (error) {
      logger.error({ err: error }, 'Error responding to harness login');
    } finally {
      setCancelling(false);
      close();
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) void handleCancel();
      }}
    >
      <DialogContent className="min-w-0 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Kimi Code 需要登录</DialogTitle>
        </DialogHeader>
        <div className="min-w-0 space-y-3 text-sm">
          <p className="text-muted-foreground">
            请在浏览器完成 Kimi 授权，登录后当前操作会自动继续。此弹窗关闭等同取消。
          </p>
          <div className="min-w-0 space-y-1">
            <span className="text-xs font-medium">登录链接</span>
            <p data-testid="harness-login-url" className="break-all font-mono text-xs">
              {request.url}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleCopy('url', request.url)}
            >
              复制链接
            </Button>
            {!expired && (
              <a
                href={request.url}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-primary underline underline-offset-4"
              >
                打开登录链接
              </a>
            )}
            {copied === 'url' && <span className="text-xs text-muted-foreground">已复制</span>}
          </div>
          <div className="min-w-0 space-y-1">
            <span className="text-xs font-medium">验证码</span>
            <div className="flex flex-wrap items-center gap-2">
              <span data-testid="harness-login-code" className="font-mono text-base tracking-widest">
                {request.userCode}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleCopy('code', request.userCode)}
              >
                复制验证码
              </Button>
              {copied === 'code' && <span className="text-xs text-muted-foreground">已复制</span>}
            </div>
          </div>
          {expired ? (
            <p role="status" className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              登录未完成，可重试
            </p>
          ) : (
            <p role="status" className="text-xs text-muted-foreground">
              等待授权完成… 剩余 {formatRemaining(remaining)}
            </p>
          )}
          {!expired && (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => void handleCancel()}
              disabled={cancelling}
            >
              取消
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
