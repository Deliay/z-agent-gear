import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Checkbox } from '../ui/checkbox';
import { optionLabel } from '../../lib/elicitation-form';
import type { ElicitationRequestedSchema, ElicitationSchemaProperty } from '../../graphql/types';

export interface ElicitationFieldsProps {
  schema: ElicitationRequestedSchema | null | undefined;
  values: Record<string, unknown>;
  disabled?: boolean;
  onChange: (name: string, value: unknown) => void;
}

/**
 * 共享 elicitation 表单渲染（自 `ElicitationDialog` 提取，口径零变化）：
 * 单选组 / 数字 / 布尔 / 多选勾选组（`items.oneOf → items.anyOf → items.enum`）/ 文本框。
 * 会话卡片（InteractionCard）使用；通知弹窗不再承载表单。
 */
export function ElicitationFields({ schema, values, disabled = false, onChange }: ElicitationFieldsProps) {
  const properties = schema?.properties ?? {};
  const requiredFields = schema?.required ?? [];

  const toggleArrayValue = (name: string, option: unknown, checked: boolean) => {
    const current = Array.isArray(values[name]) ? (values[name] as unknown[]) : [];
    const next = checked ? [...current, option] : current.filter((v) => v !== option);
    onChange(name, next);
  };

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
                  disabled={disabled}
                  onChange={() => onChange(name, option.value)}
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
            disabled={disabled}
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => onChange(name, e.target.value === '' ? undefined : Number(e.target.value))}
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
            disabled={disabled}
            onCheckedChange={(checked) => onChange(name, checked === true)}
          />
          <Label htmlFor={name}>
            {label}
            {required && <span className="text-destructive">*</span>}
          </Label>
          {prop.description && <p className="text-xs text-muted-foreground">{prop.description}</p>}
        </div>
      );
    }

    // array：多选勾选组（items.oneOf → items.anyOf → items.enum）
    if (prop.type === 'array' && (prop.items?.enum || prop.items?.oneOf || prop.items?.anyOf)) {
      const options = prop.items.oneOf
        ? prop.items.oneOf.map((o) => ({
            value: o.const,
            label: o.title || optionLabel(o.const),
            description: o.description,
          }))
        : prop.items.anyOf
          ? prop.items.anyOf.map((o) => ({
              value: o.const,
              label: o.title || optionLabel(o.const),
              description: o.description,
            }))
          : (prop.items.enum ?? []).map((v) => ({ value: v, label: optionLabel(v), description: undefined }));
      const selected = Array.isArray(value) ? value : [];
      return (
        <div key={name} className="space-y-2" role="group" aria-label={label}>
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
                  disabled={disabled}
                  onCheckedChange={(checked) => toggleArrayValue(name, option.value, checked === true)}
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
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(name, e.target.value)}
        />
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {schema?.description && <p className="text-xs text-muted-foreground">{schema.description}</p>}
      {Object.entries(properties).map(([name, prop]) => renderField(name, prop))}
    </div>
  );
}
