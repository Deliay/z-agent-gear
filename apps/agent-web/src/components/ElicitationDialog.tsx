import { useMemo, useState } from 'react';
import { useMutation } from '@apollo/client/react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Checkbox } from './ui/checkbox';
import { RESPOND_ELICITATION } from '../graphql/mutations';
import type {
  TodoItemData,
  RespondElicitationMutation,
  ElicitationAction,
  ElicitationRequestedSchema,
  ElicitationSchemaProperty,
} from '../graphql/types';

interface ElicitationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  todo: TodoItemData;
  onResponded?: () => void;
}

// 从 schema 构建默认值（boolean 默认 false）
function buildDefaults(schema: ElicitationRequestedSchema | null | undefined): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(schema?.properties ?? {})) {
    if (prop.default !== undefined) {
      defaults[name] = prop.default;
    } else if (prop.type === 'boolean') {
      defaults[name] = false;
    }
  }
  return defaults;
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function optionLabel(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

interface UrlParts {
  origin: string;
  host: string;
  rest: string;
}

function splitUrl(url: string): UrlParts | null {
  try {
    const parsed = new URL(url);
    return {
      origin: `${parsed.protocol}//`,
      host: parsed.host,
      rest: `${parsed.pathname}${parsed.search}${parsed.hash}`,
    };
  } catch {
    return null;
  }
}

export function ElicitationDialog({ open, onOpenChange, todo, onResponded }: ElicitationDialogProps) {
  const [responding, setResponding] = useState(false);
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [respondElicitation] = useMutation<RespondElicitationMutation>(RESPOND_ELICITATION);

  const data = todo.elicitationData;
  const schema = data?.requestedSchema;
  const properties = schema?.properties ?? {};
  const requiredFields = useMemo(() => schema?.required ?? [], [schema]);
  const defaults = useMemo(() => buildDefaults(schema), [schema]);
  // 表单值 = schema 默认值 + 用户编辑
  const values: Record<string, unknown> = { ...defaults, ...edits };

  const missingRequired = requiredFields.filter((name) => isEmptyValue(values[name]));
  const urlParts = data?.url ? splitUrl(data.url) : null;

  const [now] = useState(() => Date.now());
  // 终态判定：resolution 优先；TTL 未清理的窄窗口内 expiresAt 已过也按过期处理
  const isExpired = todo.resolution === 'expired'
    || (!todo.resolution && Boolean(todo.expiresAt) && new Date(todo.expiresAt as string).getTime() <= now);
  const isCancelled = todo.resolution === 'cancelled' || todo.resolution === 'failed';
  const isFinished = todo.resolution === 'accepted' || todo.resolution === 'declined';
  const isClosed = isExpired || isCancelled || isFinished;

  const statusMessage = isExpired
    ? '该问询已过期'
    : todo.resolution === 'cancelled'
      ? '该问询已取消'
      : todo.resolution === 'failed'
        ? '该问询已失效'
        : todo.resolution === 'accepted'
          ? '该问询已提交'
          : todo.resolution === 'declined'
            ? '该问询已拒绝'
            : null;

  const setValue = (name: string, value: unknown) => {
    setEdits((prev) => ({ ...prev, [name]: value }));
  };

  const toggleArrayValue = (name: string, option: unknown, checked: boolean) => {
    const current = Array.isArray(values[name]) ? (values[name] as unknown[]) : [];
    const next = checked ? [...current, option] : current.filter((v) => v !== option);
    setValue(name, next);
  };

  const handleRespond = async (action: ElicitationAction) => {
    if (!data) return;

    setResponding(true);
    try {
      await respondElicitation({
        variables: {
          requestId: data.requestId,
          action,
          values: action === 'accept' && data.mode === 'form' ? values : null,
        },
      });
      onResponded?.();
      onOpenChange(false);
    } catch (error) {
      console.error('Error responding to elicitation:', error);
    } finally {
      setResponding(false);
    }
  };

  const handleOpenUrl = async () => {
    if (!data?.url) return;
    window.open(data.url, '_blank', 'noopener,noreferrer');
    await handleRespond('accept');
  };

  if (!data) return null;

  const renderField = (name: string, prop: ElicitationSchemaProperty) => {
    const label = prop.title || name;
    const required = requiredFields.includes(name);
    const value = values[name];

    // string 枚举：单选组
    if (prop.type === 'string' && (prop.enum || prop.oneOf)) {
      const options = prop.oneOf
        ? prop.oneOf.map((o) => ({ value: o.const, label: o.title || optionLabel(o.const), description: o.description }))
        : (prop.enum ?? []).map((v) => ({ value: v, label: optionLabel(v), description: undefined }));
      return (
        <div key={name} className="space-y-2" role="radiogroup" aria-label={label}>
          <Label>
            {label}
            {required && <span className="text-destructive">*</span>}
          </Label>
          {prop.description && <p className="text-xs text-muted-foreground">{prop.description}</p>}
          <div className="space-y-1">
            {options.map((option) => (
              <label key={option.label} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name={name}
                  checked={value === option.value}
                  onChange={() => setValue(name, option.value)}
                />
                <span>
                  {option.label}
                  {option.description && (
                    <span className="block text-xs text-muted-foreground">{option.description}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </div>
      );
    }

    // number / integer：数字输入
    if (prop.type === 'number' || prop.type === 'integer') {
      return (
        <div key={name} className="space-y-2">
          <Label htmlFor={name}>
            {label}
            {required && <span className="text-destructive">*</span>}
          </Label>
          {prop.description && <p className="text-xs text-muted-foreground">{prop.description}</p>}
          <Input
            id={name}
            type="number"
            min={prop.minimum}
            max={prop.maximum}
            step={prop.type === 'integer' ? 1 : undefined}
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => setValue(name, e.target.value === '' ? undefined : Number(e.target.value))}
          />
        </div>
      );
    }

    // boolean：勾选框
    if (prop.type === 'boolean') {
      return (
        <div key={name} className="flex items-center gap-2">
          <Checkbox
            id={name}
            checked={value === true}
            onCheckedChange={(checked) => setValue(name, checked === true)}
          />
          <Label htmlFor={name}>
            {label}
            {required && <span className="text-destructive">*</span>}
          </Label>
          {prop.description && <p className="text-xs text-muted-foreground">{prop.description}</p>}
        </div>
      );
    }

    // array：多选勾选组（items.enum / items.oneOf）
    if (prop.type === 'array' && (prop.items?.enum || prop.items?.oneOf)) {
      const options = prop.items.oneOf
        ? prop.items.oneOf.map((o) => ({ value: o.const, label: o.title || optionLabel(o.const) }))
        : (prop.items.enum ?? []).map((v) => ({ value: v, label: optionLabel(v) }));
      const selected = Array.isArray(value) ? value : [];
      return (
        <div key={name} className="space-y-2">
          <Label>
            {label}
            {required && <span className="text-destructive">*</span>}
          </Label>
          {prop.description && <p className="text-xs text-muted-foreground">{prop.description}</p>}
          <div className="space-y-1">
            {options.map((option) => (
              <label key={option.label} className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox
                  checked={selected.includes(option.value)}
                  onCheckedChange={(checked) => toggleArrayValue(name, option.value, checked === true)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </div>
      );
    }

    // 其他 string：文本框（format email/uri/date 使用对应 input type）
    const inputType =
      prop.format === 'email' ? 'email' : prop.format === 'uri' ? 'url' : prop.format === 'date' ? 'date' : 'text';
    return (
      <div key={name} className="space-y-2">
        <Label htmlFor={name}>
          {label}
          {required && <span className="text-destructive">*</span>}
        </Label>
        {prop.description && <p className="text-xs text-muted-foreground">{prop.description}</p>}
        <Input
          id={name}
          type={inputType}
          minLength={prop.minLength}
          maxLength={prop.maxLength}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => setValue(name, e.target.value)}
        />
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{todo.title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{data.message}</p>

          {statusMessage && (
            <p
              data-testid="elicitation-status"
              className={`rounded-md px-3 py-2 text-sm ${
                isExpired || isCancelled
                  ? 'bg-muted text-muted-foreground'
                  : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              }`}
            >
              {statusMessage}
              {!isFinished && '，该问询已不可操作。'}
            </p>
          )}

          {data.mode === 'form' && (
            <div className="space-y-4">
              {schema?.description && (
                <p className="text-xs text-muted-foreground">{schema.description}</p>
              )}
              {Object.entries(properties).map(([name, prop]) => renderField(name, prop))}
            </div>
          )}

          {data.mode === 'url' && data.url && (
            <div className="p-3 bg-muted rounded-lg space-y-1">
              <p className="text-sm font-medium">请求打开链接</p>
              <p className="text-xs font-mono break-all">
                {urlParts ? (
                  <>
                    <span>{urlParts.origin}</span>
                    <span className="font-bold">{urlParts.host}</span>
                    <span>{urlParts.rest}</span>
                  </>
                ) : (
                  <span className="font-bold">{data.url}</span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">请确认目标主机后再打开链接</p>
            </div>
          )}

          {data.mode === 'form' && missingRequired.length > 0 && (
            <p className="text-xs text-destructive">
              请填写必填项：{missingRequired.map((name) => properties[name]?.title || name).join('、')}
            </p>
          )}

          <div className="flex flex-col gap-2">
            {isClosed ? null : data.mode === 'url' ? (
              <Button onClick={handleOpenUrl} disabled={responding || !data.url}>
                打开链接
              </Button>
            ) : (
              <Button
                onClick={() => handleRespond('accept')}
                disabled={responding || missingRequired.length > 0}
              >
                提交
              </Button>
            )}
            {!isClosed && (
              <>
                <Button
                  variant="destructive"
                  onClick={() => handleRespond('decline')}
                  disabled={responding}
                >
                  拒绝
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleRespond('cancel')}
                  disabled={responding}
                >
                  取消
                </Button>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
