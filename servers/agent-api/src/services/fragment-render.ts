/**
 * Fragment 模板渲染**唯一口径**（需求 #449；契约 `contracts/fragment-template.md`）。
 *
 * 纯函数 + 注入 `ValutResolver`（不 import 任何 Mongoose 模型，便于独立单测与依赖倒置）：
 * - `Plain`：原样输出（空串省略），`format` 无意义恒按 Generic；
 * - `Valut`：以 `value` 为 key 在 `context.workspaceId` 的 manual namespace 取值，
 *   取不到 → `valut key not found: <key>`；
 * - `Parameter`：取 `context.params[value]`，缺失 → `missing parameter: <key>`；
 * - 格式管线：Generic 恒等 / Json = `JSON.stringify` / Uri = `encodeURIComponent`（只编码一次）；
 * - 上限：数量 ≤200、单值 ≤4096、结果总长 ≤65536，超限 → `fragment template too large`。
 *
 * 安全红线：解密值只在本次调用栈内存中出现；本模块不记录任何片段内容/渲染中间值日志。
 */

export type FragmentType = 'Plain' | 'Valut' | 'Parameter';
export type FragmentFormat = 'Generic' | 'Json' | 'Uri';

export interface Fragment {
  type: FragmentType;
  value: string;
  format: FragmentFormat;
}

export interface RenderContext {
  userId: string;
  tenantId: string;
  workspaceId: string;
  params: Record<string, string>;
}

export type ValutResolver = (key: string, ctx: { workspaceId: string }) => Promise<string | null>;

export const FRAGMENT_ELEMENT_MAX_COUNT = 200;
export const FRAGMENT_VALUE_MAX_LENGTH = 4096;
export const FRAGMENT_RENDER_MAX_LENGTH = 65536;

const FRAGMENT_TYPES: readonly FragmentType[] = ['Plain', 'Valut', 'Parameter'];
const FRAGMENT_FORMATS: readonly FragmentFormat[] = ['Generic', 'Json', 'Uri'];

export const FRAGMENT_ERRORS = {
  notFound: (key: string) => `valut key not found: ${key}`,
  missingParameter: (key: string) => `missing parameter: ${key}`,
  tooLarge: 'fragment template too large',
  invalid: 'invalid fragment template',
} as const;

function isFragmentType(value: unknown): value is FragmentType {
  return typeof value === 'string' && (FRAGMENT_TYPES as readonly string[]).includes(value);
}

function isFragmentFormat(value: unknown): value is FragmentFormat {
  return typeof value === 'string' && (FRAGMENT_FORMATS as readonly string[]).includes(value);
}

/**
 * 模板形状与上限校验（渲染前；创建/更新保存期复用）。
 * - 结构/枚举非法 → `invalid fragment template`；
 * - 数量或单值超限 → `fragment template too large`。
 */
export function validateFragments(fragments: unknown): Fragment[] {
  if (!Array.isArray(fragments)) throw new Error(FRAGMENT_ERRORS.invalid);
  if (fragments.length > FRAGMENT_ELEMENT_MAX_COUNT) throw new Error(FRAGMENT_ERRORS.tooLarge);
  return fragments.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error(FRAGMENT_ERRORS.invalid);
    const { type, value, format } = raw as Record<string, unknown>;
    if (!isFragmentType(type) || !isFragmentFormat(format) || typeof value !== 'string') {
      throw new Error(FRAGMENT_ERRORS.invalid);
    }
    if (value.length > FRAGMENT_VALUE_MAX_LENGTH) throw new Error(FRAGMENT_ERRORS.tooLarge);
    return { type, value, format };
  });
}

/** 格式管线（独立导出便于单测）：Generic 恒等 / Json 带引号转义 / Uri URL 编码。 */
export function applyFormat(value: string, format: FragmentFormat): string {
  switch (format) {
    case 'Json':
      return JSON.stringify(value);
    case 'Uri':
      return encodeURIComponent(value);
    case 'Generic':
    default:
      return value;
  }
}

/** 逐片段求值并拼接（异步：Valut 取值）。 */
export async function renderFragments(
  fragments: Fragment[],
  context: RenderContext,
  resolveValut: ValutResolver,
): Promise<string> {
  const list = validateFragments(fragments);
  const parts: string[] = [];
  let total = 0;

  for (const fragment of list) {
    if (fragment.type === 'Plain') {
      // Plain 恒按 Generic 处理；空串省略（契约 §2）
      if (fragment.value === '') continue;
      parts.push(fragment.value);
      total += fragment.value.length;
      if (total > FRAGMENT_RENDER_MAX_LENGTH) throw new Error(FRAGMENT_ERRORS.tooLarge);
      continue;
    }

    let resolved: string;
    if (fragment.type === 'Valut') {
      const key = fragment.value;
      const value = await resolveValut(key, { workspaceId: context.workspaceId });
      if (value === null || value === undefined) {
        throw new Error(FRAGMENT_ERRORS.notFound(key));
      }
      resolved = value;
    } else {
      const key = fragment.value;
      const value = context.params?.[key];
      if (value === undefined) throw new Error(FRAGMENT_ERRORS.missingParameter(key));
      resolved = value;
    }

    const rendered = applyFormat(resolved, fragment.format);
    parts.push(rendered);
    total += rendered.length;
    if (total > FRAGMENT_RENDER_MAX_LENGTH) throw new Error(FRAGMENT_ERRORS.tooLarge);
  }

  return parts.join('');
}
