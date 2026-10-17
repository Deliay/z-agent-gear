import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type {
  CloudWorkloadData,
  CloudWorkloadParamValue,
} from '@/graphql/types';
import {
  resolveParamValue,
  type ParamValueError,
  type WorkloadParamValues,
} from '@/lib/workload-params';

interface WorkloadParamsFormProps {
  workload: CloudWorkloadData;
  values: WorkloadParamValues;
  onChange: (next: WorkloadParamValues) => void;
  errors?: ParamValueError[];
  disabled?: boolean;
}

function errorFor(errors: ParamValueError[], key: string): string | null {
  return errors.find((error) => error.key === key)?.message ?? null;
}

/** 按 `paramSchema` 渲染单个工作负载的参数表单（默认值预填、以键是否存在判定填写）。 */
export default function WorkloadParamsForm({
  workload,
  values,
  onChange,
  errors = [],
  disabled = false,
}: WorkloadParamsFormProps) {
  const schema = workload.paramSchema ?? [];
  if (schema.length === 0) {
    return <p className="text-xs text-muted-foreground">无参数</p>;
  }

  const setValue = (key: string, value: CloudWorkloadParamValue): void => {
    onChange({ ...values, [key]: value });
  };

  return (
    <div className="min-w-0 space-y-3">
      {schema.map((field) => {
        const value = resolveParamValue(field, values);
        const message = errorFor(errors, field.key);
        return (
          <div key={field.key} className="min-w-0 space-y-1">
            <Label htmlFor={`param-${workload.id}-${field.key}`}>{field.label}</Label>
            {field.type === 'SELECT' ? (
              <select
                id={`param-${workload.id}-${field.key}`}
                aria-label={field.label}
                disabled={disabled}
                value={typeof value === 'string' ? value : ''}
                onChange={(e) => setValue(field.key, e.target.value)}
                className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <option value="">请选择</option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : field.type === 'MULTI_SELECT' ? (
              <div className="flex flex-wrap gap-3">
                {(field.options ?? []).map((option) => {
                  const selected = Array.isArray(value) ? value : [];
                  return (
                    <label
                      key={option}
                      className="flex items-center gap-1.5 text-sm text-foreground"
                    >
                      <input
                        type="checkbox"
                        aria-label={option}
                        disabled={disabled}
                        checked={selected.includes(option)}
                        onChange={(e) => {
                          // 归一为「可选项顺序」，使同一逻辑值产生稳定的 params 快照（日志留档稳定）。
                          const next = new Set(selected);
                          if (e.target.checked) {
                            next.add(option);
                          } else {
                            next.delete(option);
                          }
                          setValue(
                            field.key,
                            (field.options ?? []).filter((candidate) => next.has(candidate)),
                          );
                        }}
                      />
                      {option}
                    </label>
                  );
                })}
              </div>
            ) : field.type === 'BOOLEAN' ? (
              <Switch
                aria-label={field.label}
                disabled={disabled}
                checked={value === true}
                onCheckedChange={(checked) => setValue(field.key, checked)}
              />
            ) : (
              <Input
                id={`param-${workload.id}-${field.key}`}
                aria-label={field.label}
                disabled={disabled}
                value={typeof value === 'string' ? value : ''}
                onChange={(e) => setValue(field.key, e.target.value)}
              />
            )}
            {message && <p className="text-xs text-destructive">{message}</p>}
          </div>
        );
      })}
    </div>
  );
}
