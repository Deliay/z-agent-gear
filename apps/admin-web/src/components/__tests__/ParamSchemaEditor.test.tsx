import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ParamSchemaEditor from '@/components/cloud-workloads/ParamSchemaEditor';
import {
  validateParamSchema,
  normalizeParamSchema,
  type ParamSchemaError,
} from '@/lib/workload-params';
import type { CloudWorkloadParamFieldInputData } from '@/graphql/types';

function param(
  overrides: Partial<CloudWorkloadParamFieldInputData> = {},
): CloudWorkloadParamFieldInputData {
  return { key: 'version', label: '版本', type: 'TEXT', options: [], defaultValue: '22', ...overrides };
}

function Harness({ initial }: { initial: CloudWorkloadParamFieldInputData[] }) {
  const [value, setValue] = useState(initial);
  return <ParamSchemaEditor value={value} onChange={setValue} />;
}

describe('validateParamSchema (T-FP3, pre-validation only)', () => {
  it('accepts a valid schema of all four types', () => {
    const errors = validateParamSchema([
      param(),
      param({ key: 'mode', label: '模式', type: 'SELECT', options: ['a', 'b'], defaultValue: 'a' }),
      param({
        key: 'pms',
        label: '包管理器',
        type: 'MULTI_SELECT',
        options: ['npm', 'pnpm'],
        defaultValue: ['npm'],
      }),
      param({ key: 'enabled', label: '启用', type: 'BOOLEAN', options: [], defaultValue: false }),
    ]);
    expect(errors).toEqual([]);
  });

  it('flags duplicate keys', () => {
    const errors = validateParamSchema([param(), param({ label: '另一个' })]);
    expect(errors).toContainEqual(
      expect.objectContaining({ index: 1, field: 'key' }),
    );
  });

  it('flags invalid key format', () => {
    const errors = validateParamSchema([param({ key: 'Bad-Key' })]);
    expect(errors).toContainEqual(expect.objectContaining({ index: 0, field: 'key' }));
  });

  it('flags empty key and empty label', () => {
    const errors = validateParamSchema([param({ key: '', label: '' })]);
    expect(errors).toContainEqual(expect.objectContaining({ index: 0, field: 'key' }));
    expect(errors).toContainEqual(expect.objectContaining({ index: 0, field: 'label' }));
  });

  it('flags a select type without options', () => {
    const errors = validateParamSchema([
      param({ type: 'SELECT', options: [], defaultValue: '' }),
    ]);
    expect(errors).toContainEqual(expect.objectContaining({ index: 0, field: 'options' }));
  });

  it('flags a select default value outside the options', () => {
    const errors = validateParamSchema([
      param({ type: 'SELECT', options: ['a', 'b'], defaultValue: 'c' }),
    ]);
    expect(errors).toContainEqual(expect.objectContaining({ index: 0, field: 'defaultValue' }));
  });

  it('flags duplicate options', () => {
    const errors = validateParamSchema([
      param({ type: 'SELECT', options: ['a', 'a'], defaultValue: 'a' }),
    ]);
    expect(errors).toContainEqual(expect.objectContaining({ index: 0, field: 'options' }));
  });

  it('flags a missing default value', () => {
    const errors = validateParamSchema([
      param({ defaultValue: undefined as unknown as string }),
    ]);
    expect(errors).toContainEqual(expect.objectContaining({ index: 0, field: 'defaultValue' }));
  });

  it('normalizes options away for non-select types', () => {
    const [normalized] = normalizeParamSchema([
      param({ type: 'TEXT', options: ['ignored'], defaultValue: 'x' }),
    ]);
    expect(normalized.options).toEqual([]);
  });
});

describe('ParamSchemaEditor (T-FP2)', () => {
  it('adds and removes a parameter', () => {
    render(<Harness initial={[]} />);
    expect(screen.getByText('暂无参数，点击「添加参数」新增。')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /添加参数/ }));
    expect(screen.getByLabelText('参数标识')).toBeDefined();
    expect(screen.getByLabelText('显示名称')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: '删除参数 1' }));
    expect(screen.queryByLabelText('参数标识')).toBeNull();
  });

  it('switches the default-value control by field type', () => {
    render(<Harness initial={[param()]} />);

    const typeSelect = screen.getByLabelText('字段类型');
    // TEXT：文本输入
    expect(screen.getByLabelText('默认值').tagName).toBe('INPUT');

    // SELECT：出现可选项编辑 + 下拉默认值
    fireEvent.change(typeSelect, { target: { value: 'SELECT' } });
    expect(screen.getByLabelText('可选项').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('默认值').tagName).toBe('SELECT');

    // MULTI_SELECT：默认值为可选项多选（复选框）
    fireEvent.change(typeSelect, { target: { value: 'MULTI_SELECT' } });
    fireEvent.change(screen.getByLabelText('可选项'), { target: { value: 'npm\npnpm' } });
    expect(screen.getByRole('checkbox', { name: 'npm' })).toBeDefined();

    // BOOLEAN：开关
    fireEvent.change(typeSelect, { target: { value: 'BOOLEAN' } });
    expect(screen.getByRole('switch')).toBeDefined();
  });

  it('edits options for a select type and reflects them in the default select', () => {
    render(<Harness initial={[param({ type: 'SELECT', options: ['a'], defaultValue: 'a' })]} />);

    fireEvent.change(screen.getByLabelText('可选项'), { target: { value: 'a\nb' } });
    const defaultSelect = screen.getByLabelText('默认值') as HTMLSelectElement;
    expect(Array.from(defaultSelect.options).map((option) => option.value)).toEqual([
      '',
      'a',
      'b',
    ]);

    fireEvent.change(defaultSelect, { target: { value: 'b' } });
    expect(defaultSelect.value).toBe('b');
  });

  it('reorders parameters with move up/down', () => {
    render(<Harness initial={[param({ key: 'first' }), param({ key: 'second', label: '第二' })]} />);

    const keysBefore = () =>
      (screen.getAllByLabelText('参数标识') as HTMLInputElement[]).map((input) => input.value);
    expect(keysBefore()).toEqual(['first', 'second']);

    fireEvent.click(screen.getByRole('button', { name: '下移参数 1' }));
    expect(keysBefore()).toEqual(['second', 'first']);

    fireEvent.click(screen.getByRole('button', { name: '上移参数 2' }));
    expect(keysBefore()).toEqual(['first', 'second']);
  });

  it('renders located pre-validation errors', () => {
    const errors: ParamSchemaError[] = [
      { index: 0, field: 'key', message: '参数标识必填' },
    ];
    render(<ParamSchemaEditor value={[param({ key: '' })]} onChange={vi.fn()} errors={errors} />);
    expect(screen.getByText('参数标识必填')).toBeDefined();
  });
});
