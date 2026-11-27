import { describe, expect, it } from 'vitest';

const agentWebSources = import.meta.glob(
  ['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../**/*.d.ts', '!../**/__tests__/**'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const MICRO_FONT_REGEX = /\btext-\[(?:[1-9]|1[01])px\]/g;

/**
 * T-UIUX-COLOR：硬编码色值零容忍。
 *
 * 覆盖三类：
 * 1. 调色板类 `text-|bg-|border-<palette>-<n>`；
 * 2. 纯黑白 `bg-black|bg-white|text-black|text-white|border-black|border-white`；
 * 3. 任意值色值 `bg-[#fff]` / `text-[color:...]` / `ring-[rgb(...)]` 等。
 *
 * 豁免白名单（逐条附注原因）：
 * - `lib/terminal-theme.ts`：xterm 深黑终端 16 色/256 色/真彩色调色板，属规范 §2.3 专色定义处；
 * - `lib/preview/html-inject.ts`：注入 iframe 沙箱的独立 CSS 字符串，读不到宿主 CSS Token，
 *   且属规范 §2.3 预览专色（hover/selected），非界面表面色。
 */
const HARDCODED_COLOR_REGEX =
  /\b(?:text|bg|border|ring|from|to|via|fill|stroke|divide|placeholder)-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}|black|white)\b/g;

/** 任意值色值：`bg-[#fff]`、`text-[rgb(0_0_0)]`、`border-[color:var(--x)]` 中的具体色值 */
const ARBITRARY_COLOR_REGEX =
  /\b(?:text|bg|border|ring|from|to|via|fill|stroke|divide|placeholder)-\[[^\]]*(?:#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(|oklch\()[^\]]*\]/g;

const HARDCODED_COLOR_EXEMPT = ['/lib/terminal-theme.ts', '/lib/preview/html-inject.ts'];

/** T-UIUX-TABULAR：金额 / Token / 倒计时 / 计数徽标 / 表格数值列清单（D4）
 *  `marker` 定位具体数值容器（JSX 表达式 / data-testid / 唯一类串），
 *  断言 marker 所在行同时含 `tabular-nums`，避免「文件里任意位置出现 tabular-nums」的失效口径。
 */
const TABULAR_CHECKLIST: Array<{ file: string; marker: string; note: string }> = [
  { file: '/pages/BillingPage.tsx', marker: 'invoice.amount < 0', note: '金额表格数值列' },
  { file: '/pages/HomePage.tsx', marker: 'onlineControllers.length', note: 'KPI 统计卡' },
  { file: '/components/harness/HarnessLoginDialog.tsx', marker: 'formatRemaining(remaining)', note: '设备登录倒计时' },
  { file: '/components/session/InteractionCard.tsx', marker: 'font-mono text-xs text-muted-foreground tabular-nums', note: '交互卡片倒计时' },
  { file: '/components/session/UsageCard.tsx', marker: 'text-sm font-medium text-foreground tabular-nums', note: 'Token / 费用用量' },
  { file: '/components/settings/ModelItem.tsx', marker: 'data-testid="model-context-length"', note: '模型最长上下文' },
  { file: '/components/session/preview/ReviewPanel.tsx', marker: 'data-testid="review-file-count"', note: '评审文件计数' },
  { file: '/components/workflow/graph/WorkflowNodeCard.tsx', marker: 'bg-warning/15 px-1 text-xs tabular-nums', note: '节点返工计数' },
  { file: '/components/workflow/graph/ResourceChip.tsx', marker: 'text-xs tabular-nums text-muted-foreground', note: 'PR/Issue 数值徽标' },
  { file: '/components/workflow/NodeDetailDrawer.tsx', marker: 'bg-warning/15 px-1.5 py-0.5 text-xs tabular-nums', note: '节点详情返工计数' },
  { file: '/components/sidebar/SidebarSection.tsx', marker: '{count}', note: '侧栏计数徽章' },
  { file: '/components/tree/TreeSection.tsx', marker: '{count}', note: '树计数徽章' },
  { file: '/components/knowledge-base/RepoKnowledgeBaseSection.tsx', marker: 'text-xs tabular-nums text-muted-foreground', note: '知识库文档计数' },
  { file: '/components/ui/badge.tsx', marker: 'inline-flex items-center rounded-full border', note: '计数徽标基类' },
];

/** T-UIUX-FOCUS：原子组件焦点呈现抽样清单（规范 §4 / §7） */
const FOCUS_CHECKLIST = [
  '/components/ui/button.tsx',
  '/components/ui/input.tsx',
  '/components/ui/select.tsx',
  '/components/ui/checkbox.tsx',
  '/components/ui/switch.tsx',
];

function findSource(suffix: string): string | undefined {
  return Object.entries(agentWebSources).find(([filePath]) => filePath.endsWith(suffix))?.[1];
}

describe('UI/UX Design Standards Guard (docs/engineering/ui-ux-standards.md)', () => {
  it('T-UIUX-FONT1: apps/agent-web/src 下禁止使用小于 12px 的微字号（text-[9px]/text-[10px]/text-[11px]）', () => {
    const entries = Object.entries(agentWebSources);
    expect(entries.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const [filePath, content] of entries) {
      const matches = content.match(MICRO_FONT_REGEX);
      if (matches) {
        violations.push(`${filePath}: ${matches.join(', ')}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('T-UIUX-COLOR: 禁止硬编码色值（调色板 / 黑白 / 任意值），必须使用语义 Token（规范 §2）', () => {
    const violations: string[] = [];
    for (const [filePath, content] of Object.entries(agentWebSources)) {
      if (HARDCODED_COLOR_EXEMPT.some((exempt) => filePath.endsWith(exempt))) continue;
      const matches = [
        ...(content.match(HARDCODED_COLOR_REGEX) ?? []),
        ...(content.match(ARBITRARY_COLOR_REGEX) ?? []),
      ];
      if (matches.length > 0) {
        violations.push(`${filePath}: ${[...new Set(matches)].join(', ')}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('T-UIUX-OVERLAY: 遮罩层使用 overlay Token，禁止就地 bg-black/bg-white', () => {
    const violations: string[] = [];
    for (const [filePath, content] of Object.entries(agentWebSources)) {
      if (HARDCODED_COLOR_EXEMPT.some((exempt) => filePath.endsWith(exempt))) continue;
      const matches = content.match(/\b(?:bg|text|border)-(?:black|white)\b/g);
      if (matches) violations.push(`${filePath}: ${[...new Set(matches)].join(', ')}`);
    }
    expect(violations).toEqual([]);
  });

  it('T-UIUX-TABULAR: 金额/Token/倒计时/计数徽标/表格数值列容器必须使用 tabular-nums（D4 清单式 / 容器级断言）', () => {
    const missing: string[] = [];
    for (const { file, marker, note } of TABULAR_CHECKLIST) {
      const source = findSource(file);
      if (!source) {
        missing.push(`${file}（文件缺失：${note}）`);
        continue;
      }
      const matchedLines = source
        .split('\n')
        .filter((line) => line.includes(marker));
      if (matchedLines.length === 0) {
        missing.push(`${file}（找不到数值容器标记「${marker}」：${note}）`);
        continue;
      }
      if (!matchedLines.some((line) => line.includes('tabular-nums'))) {
        missing.push(`${file}（数值容器「${marker}」缺少 tabular-nums：${note}）`);
      }
    }

    expect(missing).toEqual([]);
  });

  it('T-UIUX-FOCUS: 可交互原子组件必须显式声明 focus-visible 焦点呈现', () => {
    const missing = FOCUS_CHECKLIST.filter((file) => {
      const source = findSource(file);
      return !source || !source.includes('focus-visible:');
    });

    expect(missing).toEqual([]);
  });
});
