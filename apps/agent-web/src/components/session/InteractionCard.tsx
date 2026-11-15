import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@apollo/client/react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { RESPOND_ELICITATION, RESPOND_PERMISSION } from '../../graphql/mutations';
import { logger } from '../../lib/logger';
import { ElicitationFields } from './elicitation-form';
import {
  buildElicitationDefaults,
  collectElicitationValues,
  missingRequiredFields,
  splitUrl,
} from '../../lib/elicitation-form';
import type {
  ElicitationAction,
  PermissionToolCallData,
  RespondElicitationMutation,
  RespondPermissionMutation,
  SessionInteractionData,
  SessionInteractionStatus,
} from '../../graphql/types';

interface InteractionCardProps {
  interaction: SessionInteractionData;
  /** 提交成功（服务端 CAS 命中）后通知容器 refetch，覆盖为权威状态 */
  onResponded?: () => void;
}

const SUMMARY_MAX_LENGTH = 200;

/** 生成工具调用参数摘要：execute→命令、edit/write/delete→文件路径、其他→JSON 摘要 */
function summarizeToolCall(toolCall: PermissionToolCallData | null): string | null {
  const raw = toolCall?.rawInput;
  if (!raw) return null;
  if (toolCall?.kind === 'execute' && typeof raw.command === 'string' && raw.command) {
    return raw.command;
  }
  if (toolCall?.kind === 'edit' || toolCall?.kind === 'write' || toolCall?.kind === 'delete') {
    const filePath = raw.filePath ?? raw.path;
    if (typeof filePath === 'string' && filePath) return filePath;
  }
  try {
    const json = JSON.stringify(raw);
    return json.length > SUMMARY_MAX_LENGTH ? `${json.slice(0, SUMMARY_MAX_LENGTH)}…` : json;
  } catch {
    return null;
  }
}

function interactionStatusLabel(
  status: SessionInteractionStatus,
  kind: SessionInteractionData['kind'],
  selectedOptionKind?: string | null,
): string {
  switch (status) {
    case 'PENDING':
      return '待处理';
    case 'ACCEPTED':
      if (kind === 'PERMISSION') {
        // outcome=selected 统一落 ACCEPTED；徽标按所选 option.kind 区分批准/拒绝（PRD 功能点 2）
        return selectedOptionKind?.startsWith('reject') ? '已拒绝' : '已批准';
      }
      return '已提交';
    case 'DECLINED':
      return '已拒绝';
    case 'CANCELLED':
      return '已取消';
    case 'EXPIRED':
      return '已过期';
    case 'FAILED':
    default:
      return '已失效';
  }
}

function statusBadgeClass(status: SessionInteractionStatus, rejectedSelection = false): string {
  if (status === 'PENDING') return 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400';
  if (rejectedSelection) return 'border-destructive/40 bg-destructive/10 text-destructive';
  if (status === 'ACCEPTED') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
  if (status === 'DECLINED') return 'border-destructive/40 bg-destructive/10 text-destructive';
  return 'border-border bg-muted text-muted-foreground';
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** 卡片级倒计时：按剩余时长到秒跳变（不固定 1s 空转），终态/无 expiresAt 不定时 */
function useRemainingMs(expiresAt: string | null, active: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || !expiresAt) return;
    setNow(Date.now());
    const target = new Date(expiresAt).getTime();
    if (Number.isNaN(target) || target <= Date.now()) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      setNow(Date.now());
      if (Date.now() < target) {
        timer = setTimeout(tick, 1_000);
      }
    };
    timer = setTimeout(tick, 1_000);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [expiresAt, active]);
  if (!expiresAt) return null;
  const target = new Date(expiresAt).getTime();
  if (Number.isNaN(target)) return null;
  return Math.max(0, target - now);
}

/**
 * 会话时间线交互卡片（Elicitation / Permission）。
 *
 * - PENDING：可作答 + 倒计时（`expiresAt` 唯一依据，归零本地立即禁用展示已过期）；
 * - ACCEPTED：禁用并按 schema 字段标签回显提交内容 / 所选审批项；
 * - 其余终态：禁用 + 状态徽标（已拒绝/已取消/已过期/已失效）。
 *
 * 容器携带 `data-interaction-id` 供通知弹窗/Banner 滚动定位。
 */
export default function InteractionCard({ interaction, onResponded }: InteractionCardProps) {
  const [responding, setResponding] = useState(false);
  const [respondElicitation] = useMutation<RespondElicitationMutation>(RESPOND_ELICITATION);
  const [respondPermission] = useMutation<RespondPermissionMutation>(RESPOND_PERMISSION);

  const schema = interaction.requestedSchema;
  const properties = useMemo(() => schema?.properties ?? {}, [schema]);
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const values = useMemo(
    () => ({ ...buildElicitationDefaults(schema), ...edits }),
    [schema, edits],
  );

  const remainingMs = useRemainingMs(interaction.expiresAt, interaction.status === 'PENDING');
  const locallyExpired = interaction.status === 'PENDING' && remainingMs === 0;
  const effectiveStatus: SessionInteractionStatus = locallyExpired ? 'EXPIRED' : interaction.status;
  const pending = effectiveStatus === 'PENDING';
  const missingRequired = pending ? missingRequiredFields(schema, values) : [];
  const urlParts = interaction.url ? splitUrl(interaction.url) : null;
  const toolCallSummary = summarizeToolCall(interaction.toolCall);
  const acceptedOption = interaction.response?.optionId
    ? (interaction.options ?? []).find((option) => option.optionId === interaction.response?.optionId)
    : null;
  const rejectedSelection =
    interaction.kind === 'PERMISSION' &&
    effectiveStatus === 'ACCEPTED' &&
    Boolean(acceptedOption?.kind?.startsWith('reject'));

  const setValue = (name: string, value: unknown) => {
    setEdits((prev) => ({ ...prev, [name]: value }));
  };

  const refresh = () => {
    onResponded?.();
  };

  const handleElicitation = async (action: ElicitationAction) => {
    if (!pending) return;
    setResponding(true);
    try {
      const payload = interaction.mode === 'form' ? collectElicitationValues(values) : null;
      await respondElicitation({
        variables: {
          requestId: interaction.interactionId,
          action,
          values: action === 'accept' && interaction.mode === 'form' ? payload : null,
        },
      });
      refresh();
    } catch (error) {
      logger.error({ err: error, interactionId: interaction.interactionId }, 'Error responding to elicitation card');
    } finally {
      setResponding(false);
    }
  };

  const handlePermission = async (optionId?: string) => {
    if (!pending) return;
    setResponding(true);
    try {
      await respondPermission({
        variables: {
          requestId: interaction.interactionId,
          outcome: optionId ? 'selected' : 'cancelled',
          optionId,
        },
      });
      refresh();
    } catch (error) {
      logger.error({ err: error, interactionId: interaction.interactionId }, 'Error responding to permission card');
    } finally {
      setResponding(false);
    }
  };

  const handleOpenUrl = async () => {
    if (!interaction.url || !pending) return;
    // 只允许 http(s)：不得把 javascript:/data: 交给 window.open
    try {
      const parsed = new URL(interaction.url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    } catch {
      return;
    }
    window.open(interaction.url, '_blank', 'noopener,noreferrer');
    await handleElicitation('accept');
  };

  // 提交内容回显（ACCEPTED + elicitation form）：按 schema 字段标签
  const submittedEntries = useMemo(() => {
    const submitted = interaction.response?.values;
    if (!submitted || typeof submitted !== 'object') return [];
    return Object.entries(submitted as Record<string, unknown>).map(([name, value]) => ({
      label: properties[name]?.title || name,
      value: Array.isArray(value) ? value.join('、') : String(value ?? ''),
    }));
  }, [interaction.response, properties]);

  return (
    <div
      data-interaction-id={interaction.interactionId}
      data-testid={`interaction-card-${interaction.interactionId}`}
      data-status={effectiveStatus}
      className="min-w-0 rounded-lg border bg-card p-3 text-card-foreground shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{interaction.kind === 'PERMISSION' ? '权限审批' : '提问'}</Badge>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {interaction.message || (interaction.kind === 'PERMISSION' ? 'Agent 请求权限' : 'Agent 请求输入')}
        </span>
        <span
          data-testid="interaction-status"
          className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadgeClass(effectiveStatus, rejectedSelection)}`}
        >
          {interactionStatusLabel(effectiveStatus, interaction.kind, acceptedOption?.kind)}
        </span>
        {pending && remainingMs != null && (
          <span
            data-testid="interaction-countdown"
            role="timer"
            aria-live="off"
            className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
          >
            {formatRemaining(remainingMs)}
          </span>
        )}
      </div>

      {interaction.kind === 'ELICITATION' && interaction.mode === 'url' && interaction.url && (
        <div className="mt-3 space-y-1 rounded-lg bg-muted p-3">
          <p className="text-sm font-medium">请求打开链接</p>
          <p className="text-xs font-mono break-all">
            {urlParts ? (
              <>
                <span>{urlParts.origin}</span>
                <span className="font-bold">{urlParts.host}</span>
                <span>{urlParts.rest}</span>
              </>
            ) : (
              <span className="font-bold">{interaction.url}</span>
            )}
          </p>
          <p className="text-xs text-muted-foreground">请确认目标主机后再打开链接</p>
        </div>
      )}

      {interaction.kind === 'ELICITATION' && interaction.mode === 'form' && (
        <div className="mt-3 space-y-3">
          {pending ? (
            <>
              <ElicitationFields schema={schema} values={values} disabled={responding} onChange={setValue} />
              {missingRequired.length > 0 && (
                <p className="text-xs text-destructive">
                  请填写必填项：{missingRequired.map((name) => properties[name]?.title || name).join('、')}
                </p>
              )}
            </>
          ) : effectiveStatus === 'ACCEPTED' && submittedEntries.length > 0 ? (
            <dl className="space-y-1 rounded-lg bg-muted/60 p-3 text-sm" data-testid="interaction-submitted">
              {submittedEntries.map((entry) => (
                <div key={entry.label} className="flex gap-2">
                  <dt className="shrink-0 text-muted-foreground">{entry.label}</dt>
                  <dd className="min-w-0 wrap-anywhere">{entry.value || '—'}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      )}

      {interaction.kind === 'PERMISSION' && (
        <div className="mt-3 space-y-2">
          {interaction.toolCall?.title && (
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">{interaction.toolCall.title}</p>
              {interaction.toolCall.kind && <Badge variant="secondary">{interaction.toolCall.kind}</Badge>}
            </div>
          )}
          {toolCallSummary && (
            <pre className="overflow-auto rounded bg-muted p-2 text-xs font-mono whitespace-pre-wrap break-all">
              {toolCallSummary}
            </pre>
          )}
          {interaction.toolCall?.locations && interaction.toolCall.locations.length > 0 && (
            <ul className="text-xs font-mono text-muted-foreground space-y-0.5">
              {interaction.toolCall.locations.map((loc, index) => (
                <li key={`${loc.path}-${index}`}>
                  {loc.path}
                  {loc.line != null ? `:${loc.line}` : ''}
                </li>
              ))}
            </ul>
          )}
          {!pending && effectiveStatus === 'ACCEPTED' && (
            <p data-testid="interaction-selected-option" className="text-sm">
              {rejectedSelection ? '已拒绝' : '已批准'}：{acceptedOption?.name ?? interaction.response?.optionId ?? '—'}
            </p>
          )}
        </div>
      )}

      {pending && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {interaction.kind === 'ELICITATION' && interaction.mode === 'url' ? (
            <Button onClick={handleOpenUrl} disabled={responding || !interaction.url}>
              打开链接
            </Button>
          ) : interaction.kind === 'ELICITATION' ? (
            <Button onClick={() => handleElicitation('accept')} disabled={responding || missingRequired.length > 0}>
              提交
            </Button>
          ) : (
            (interaction.options ?? []).map((option) => (
              <Button
                key={option.optionId}
                variant={option.kind.startsWith('allow') ? 'default' : 'destructive'}
                onClick={() => handlePermission(option.optionId)}
                disabled={responding}
              >
                {option.name}
              </Button>
            ))
          )}
          {interaction.kind === 'ELICITATION' ? (
            <>
              <Button variant="destructive" onClick={() => handleElicitation('decline')} disabled={responding}>
                拒绝
              </Button>
              <Button variant="outline" onClick={() => handleElicitation('cancel')} disabled={responding}>
                取消
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => handlePermission()} disabled={responding}>
              取消
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
