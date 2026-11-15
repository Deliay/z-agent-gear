/**
 * Fragment 模板前端序列化/解析纯函数层（契约 `contracts/fragment-template.md` §4，计划 D7）。
 *
 * 与后端 `services/fragment-render.ts` 同源规则（fixture round-trip 互锁）：
 * - 相邻 Plain 合并；
 * - 空 Plain 省略；
 * - Valut / Parameter 为原子引用节点（不可拆分）。
 */

export type FragmentType = 'Plain' | 'Valut' | 'Parameter';
export type FragmentFormat = 'Generic' | 'Json' | 'Uri';

export interface Fragment {
  type: FragmentType;
  value: string;
  format: FragmentFormat;
}

export type EditorNode =
  | { kind: 'text'; text: string }
  | { kind: 'ref'; type: 'Valut' | 'Parameter'; value: string; format: FragmentFormat };

/** Fragment[] → 编辑器节点序列（相邻 Plain 合并、空 Plain 丢弃）。 */
export function fragmentsToNodes(fragments: Fragment[]): EditorNode[] {
  const nodes: EditorNode[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = nodes[nodes.length - 1];
    if (last?.kind === 'text') last.text += text;
    else nodes.push({ kind: 'text', text });
  };

  for (const fragment of fragments) {
    if (fragment.type === 'Plain') {
      pushText(fragment.value);
      continue;
    }
    nodes.push({
      kind: 'ref',
      type: fragment.type,
      value: fragment.value,
      format: fragment.format,
    });
  }
  return nodes;
}

/** 编辑器节点序列 → Fragment[]（相邻文本合并为单个 Plain，空文本省略）。 */
export function nodesToFragments(nodes: EditorNode[]): Fragment[] {
  const fragments: Fragment[] = [];
  const pushPlain = (value: string) => {
    if (!value) return;
    const last = fragments[fragments.length - 1];
    if (last?.type === 'Plain') last.value += value;
    else fragments.push({ type: 'Plain', value, format: 'Generic' });
  };

  for (const node of nodes) {
    if (node.kind === 'text') {
      pushPlain(node.text);
      continue;
    }
    fragments.push({ type: node.type, value: node.value, format: node.format });
  }
  return fragments;
}

/** 编辑器模式 → 新插入引用节点的格式（Plain 恒 Generic）。 */
export function formatForEditorMode(mode: 'Generic' | 'Json' | 'Uri'): FragmentFormat {
  return mode === 'Json' ? 'Json' : mode === 'Uri' ? 'Uri' : 'Generic';
}

/** 引用名称（编辑器 chip 展示：Valut 前置 #、Parameter 前置 $）。 */
export function refDisplay(type: 'Valut' | 'Parameter', value: string): string {
  return `${type === 'Valut' ? '#' : '$'}${value}`;
}

/** 片段模板可读摘要（列表/提示用，不求值）。 */
export function describeFragments(fragments: Fragment[]): string {
  return fragments
    .map((fragment) => (fragment.type === 'Plain' ? fragment.value : refDisplay(fragment.type, fragment.value)))
    .join('');
}
