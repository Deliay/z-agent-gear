import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import TagBadgeInput, { TAG_MAX_COUNT, TAG_MAX_LENGTH } from '../TagBadgeInput';

const mockToastError = vi.fn();

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...args) },
}));

function Harness({ initial = [], disabled = false }: { initial?: string[]; disabled?: boolean }) {
  const [tags, setTags] = useState<string[]>(initial);
  return (
    <div>
      <TagBadgeInput aria-label="标签" id="tags" value={tags} onChange={setTags} disabled={disabled} />
      <output data-testid="tags-value">{tags.join('|')}</output>
    </div>
  );
}

function renderHarness(initial: string[] = [], disabled = false) {
  render(<Harness initial={initial} disabled={disabled} />);
  return screen.getByLabelText('标签') as HTMLInputElement;
}

function badges(): string[] {
  return screen
    .queryAllByTestId('tag-badge')
    .map((badge) => within(badge).getByText(/./, { selector: 'span' }).textContent ?? '');
}

describe('TagBadgeInput（T-TBI1~6）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('T-TBI1 提交三触发：Enter / 英文逗号 / 中文逗号 / blur（各自 trim）', () => {
    const input = renderHarness();

    fireEvent.change(input, { target: { value: ' a ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'b' } });
    fireEvent.keyDown(input, { key: ',' });
    fireEvent.change(input, { target: { value: 'c' } });
    fireEvent.keyDown(input, { key: '，' });
    fireEvent.change(input, { target: { value: ' d ' } });
    fireEvent.blur(input);

    expect(screen.getByTestId('tags-value')).toHaveTextContent('a|b|c|d');
    expect(input).toHaveValue('');
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('T-TBI2 去重：与既有徽章（trim 后）相同 → toast 提示且不添加', () => {
    const input = renderHarness(['a']);

    fireEvent.change(input, { target: { value: ' a ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('tags-value')).toHaveTextContent('a');
    expect(badges()).toEqual(['a']);
    expect(mockToastError).toHaveBeenCalled();

    // 批内重复同口径：b 只入列一次
    fireEvent.change(input, { target: { value: 'b, b' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('tags-value')).toHaveTextContent('a|b');
  });

  it('T-TBI3 删除：徽章 × 逐枚删除；空输入 Backspace 删末枚；非空输入不删徽章', () => {
    const input = renderHarness(['a', 'b']);

    fireEvent.click(screen.getByRole('button', { name: '删除标签 a' }));
    expect(screen.getByTestId('tags-value')).toHaveTextContent('b');

    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(screen.getByTestId('tags-value')).toHaveTextContent('b');

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(screen.getByTestId('tags-value')).toHaveTextContent('');
    expect(badges()).toEqual([]);
  });

  it('T-TBI4 粘贴拆分：中英文逗号 → 逐枚去重；非法逐枚拒绝并汇总提示', () => {
    const input = renderHarness(['b']);

    fireEvent.paste(input, { clipboardData: { getData: () => 'a, b，c' } });
    expect(badges()).toEqual(['b', 'a', 'c']);
    expect(mockToastError).toHaveBeenCalled();
    expect(String(mockToastError.mock.calls[0][0])).toContain('重复');

    mockToastError.mockClear();
    const long = 'x'.repeat(TAG_MAX_LENGTH + 1);
    fireEvent.paste(input, { clipboardData: { getData: () => `ok, ${long}` } });
    expect(screen.getByTestId('tags-value')).toHaveTextContent('b|a|c|ok');
    expect(String(mockToastError.mock.calls[0][0])).toContain('32');
  });

  it('T-TBI5 上限：达 16 枚输入框禁用 + 提示；删除一枚后恢复；maxLength=32', () => {
    const sixteen = Array.from({ length: TAG_MAX_COUNT }, (_item, index) => `t${index}`);
    const input = renderHarness(sixteen);

    expect(badges()).toHaveLength(TAG_MAX_COUNT);
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('maxlength', String(TAG_MAX_LENGTH));
    expect(input).toHaveAttribute('placeholder', `最多 ${TAG_MAX_COUNT} 个标签`);

    fireEvent.click(screen.getByRole('button', { name: '删除标签 t0' }));
    expect(input).not.toBeDisabled();
  });

  it('T-TBI6 IME 门控：组合态按 Enter 不提交；compositionend 后正常提交', () => {
    const input = renderHarness();

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '中文' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('tags-value')).toHaveTextContent('');

    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('tags-value')).toHaveTextContent('中文');
  });
});
