import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { PARAM_TYPE_LABELS } from '@/components/cloud-containers/labels';
import type {
  CloudWorkloadParamFieldInputData,
  CloudWorkloadParamType,
} from '@/graphql/types';
import {
  defaultValueForType,
  createEmptyParam,
  MAX_PARAMS,
  PARAM_TYPE_OPTIONS,
  type ParamSchemaError,
  type ParamSchemaErrorField,
} from '@/lib/workload-params';

interface ParamSchemaEditorProps {
  value: CloudWorkloadParamFieldInputData[];
  onChange: (next: CloudWorkloadParamFieldInputData[]) => void;
  /** 预校验错误（服务端仍强制）；用于把错误定位到具体参数与字段 */
  errors?: ParamSchemaError[];
  disabled?: boolean;
}

function optionText(options: string[] | null | undefined): string {
  return (options ?? []).join('\n');
}

function parseOptions(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function fieldError(
  errors: ParamSchemaError[],
  index: number,
  field: ParamSchemaErrorField,
): string | null {
  return errors.find((error) => error.index === index && error.field === field)?.message ?? null;
}

function moveItem(
  list: CloudWorkloadParamFieldInputData[],
  index: number,
  delta: number,
): CloudWorkloadParamFieldInputData[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

export default function ParamSchemaEditor({
  value,
  onChange,
  errors = [],
  disabled = false,
}: ParamSchemaEditorProps) {
  const listError = errors.find((error) => error.index === -1)?.message ?? null;

  const updateField = (
    index: number,
    patch: Partial<CloudWorkloadParamFieldInputData>,
  ): void => {
    onChange(value.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const handleTypeChange = (index: number, type: CloudWorkloadParamType): void => {
    updateField(index, {
      type,
      options: type === 'SELECT' || type === 'MULTI_SELECT' ? value[index].options ?? [] : [],
      defaultValue: defaultValueForType(type),
    });
  };

  return (
    <div className="min-w-0 space-y-3">
      {listError && (
        <p role="alert" className="text-xs text-destructive">
          {listError}
        </p>
      )}

      {value.length === 0 ? (
        <p className="text-xs text-muted-foreground">暂无参数，点击「添加参数」新增。</p>
      ) : (
        <ul className="min-w-0 space-y-3">
          {value.map((field, index) => {
            const isSelect = field.type === 'SELECT' || field.type === 'MULTI_SELECT';
            const options = field.options ?? [];
            const multiValue = Array.isArray(field.defaultValue) ? field.defaultValue : [];
            return (
              <li key={index} className="min-w-0 space-y-3 rounded-md border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    参数 {index + 1}
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`上移参数 ${index + 1}`}
                      disabled={disabled || index === 0}
                      onClick={() => onChange(moveItem(value, index, -1))}
                    >
                      <ArrowUp className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`下移参数 ${index + 1}`}
                      disabled={disabled || index === value.length - 1}
                      onClick={() => onChange(moveItem(value, index, 1))}
                    >
                      <ArrowDown className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost-danger"
                      size="icon-sm"
                      aria-label={`删除参数 ${index + 1}`}
                      disabled={disabled}
                      onClick={() => onChange(value.filter((_, i) => i !== index))}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor={`param-key-${index}`}>参数标识</Label>
                    <Input
                      id={`param-key-${index}`}
                      value={field.key}
                      disabled={disabled}
                      aria-invalid={Boolean(fieldError(errors, index, 'key'))}
                      onChange={(e) => updateField(index, { key: e.target.value })}
                      placeholder="例如: version"
                    />
                    {fieldError(errors, index, 'key') && (
                      <p className="text-xs text-destructive">
                        {fieldError(errors, index, 'key')}
                      </p>
                    )}
                  </div>
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor={`param-label-${index}`}>显示名称</Label>
                    <Input
                      id={`param-label-${index}`}
                      value={field.label}
                      disabled={disabled}
                      aria-invalid={Boolean(fieldError(errors, index, 'label'))}
                      onChange={(e) => updateField(index, { label: e.target.value })}
                      placeholder="例如: 版本"
                    />
                    {fieldError(errors, index, 'label') && (
                      <p className="text-xs text-destructive">
                        {fieldError(errors, index, 'label')}
                      </p>
                    )}
                  </div>
                </div>

                <div className="min-w-0 space-y-1">
                  <Label htmlFor={`param-type-${index}`}>字段类型</Label>
                  <select
                    id={`param-type-${index}`}
                    aria-label="字段类型"
                    value={field.type}
                    disabled={disabled}
                    onChange={(e) => handleTypeChange(index, e.target.value as CloudWorkloadParamType)}
                    className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {PARAM_TYPE_OPTIONS.map((type) => (
                      <option key={type} value={type}>
                        {PARAM_TYPE_LABELS[type]}
                      </option>
                    ))}
                  </select>
                </div>

                {isSelect && (
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor={`param-options-${index}`}>可选项（每行一个）</Label>
                    <textarea
                      id={`param-options-${index}`}
                      aria-label="可选项"
                      value={optionText(options)}
                      disabled={disabled}
                      rows={3}
                      spellCheck={false}
                      onChange={(e) => updateField(index, { options: parseOptions(e.target.value) })}
                      className="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-sm whitespace-pre-wrap break-all outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    />
                    {fieldError(errors, index, 'options') && (
                      <p className="text-xs text-destructive">
                        {fieldError(errors, index, 'options')}
                      </p>
                    )}
                  </div>
                )}

                <div className="min-w-0 space-y-1">
                  <Label htmlFor={`param-default-${index}`}>默认值</Label>
                  {field.type === 'SELECT' ? (
                    <select
                      id={`param-default-${index}`}
                      aria-label="默认值"
                      value={typeof field.defaultValue === 'string' ? field.defaultValue : ''}
                      disabled={disabled}
                      onChange={(e) => updateField(index, { defaultValue: e.target.value })}
                      className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <option value="">请选择</option>
                      {options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : field.type === 'MULTI_SELECT' ? (
                    <div className="flex flex-wrap gap-3">
                      {options.length === 0 ? (
                        <span className="text-xs text-muted-foreground">请先填写可选项</span>
                      ) : (
                        options.map((option) => (
                          <label
                            key={option}
                            className="flex items-center gap-1.5 text-sm text-foreground"
                          >
                            <input
                              type="checkbox"
                              aria-label={option}
                              disabled={disabled}
                              checked={multiValue.includes(option)}
                              onChange={(e) => {
                                const next = e.target.checked
                                  ? [...multiValue, option]
                                  : multiValue.filter((item) => item !== option);
                                updateField(index, { defaultValue: next });
                              }}
                            />
                            {option}
                          </label>
                        ))
                      )}
                    </div>
                  ) : field.type === 'BOOLEAN' ? (
                    <Switch
                      aria-label="默认值"
                      disabled={disabled}
                      checked={field.defaultValue === true}
                      onCheckedChange={(checked) => updateField(index, { defaultValue: checked })}
                    />
                  ) : (
                    <Input
                      id={`param-default-${index}`}
                      aria-label="默认值"
                      value={typeof field.defaultValue === 'string' ? field.defaultValue : ''}
                      disabled={disabled}
                      aria-invalid={Boolean(fieldError(errors, index, 'defaultValue'))}
                      onChange={(e) => updateField(index, { defaultValue: e.target.value })}
                      placeholder="默认文本"
                    />
                  )}
                  {fieldError(errors, index, 'defaultValue') && (
                    <p className="text-xs text-destructive">
                      {fieldError(errors, index, 'defaultValue')}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || value.length >= MAX_PARAMS}
        onClick={() => onChange([...value, createEmptyParam()])}
      >
        <Plus className="mr-1 size-3.5" />
        添加参数
      </Button>

      <p className="text-xs text-muted-foreground">
        参数仅做前端预校验，服务端为唯一事实源；请勿在参数中存放密码 / Token。
      </p>
    </div>
  );
}
