import { describe, expect, it } from 'vitest';

const agentWebSources = import.meta.glob(
  ['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../**/*.d.ts', '!../**/__tests__/**'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

const MICRO_FONT_REGEX = /\btext-\[(?:[1-9]|1[01])px\]/g;

/**
 * T-UIUX-COLOR：硬编码调色板色值（`text-|bg-|border-<palette>-<n>`）零容忍。
 *
 * 豁免白名单（逐条附注原因）：
 * - `lib/terminal-theme.ts`：xterm 深黑终端 16 色/256 色/真彩色调色板，属规范 §2.3 专色定义处。
 */
const HARDCODED_COLOR_REGEX =
  /\b(?:text|bg|border|ring|from|to|via|fill|stroke|divide|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;

const HARDCODED_COLOR_EXEMPT = ['/lib/terminal-theme.ts'];

/** T-UIUX-TABULAR：金额 / Token / 倒计时 / 计数徽标 / 表格数值列清单（D4） */
const TABULAR_CHECKLIST: Array<{ file: string; marker: string; note: string }> = [
  { file: '/pages/BillingPage.tsx', marker: 'text-right tabular-nums', note: '金额/余额表格数值列' },
  { file: '/pages/HomePage.tsx', marker: 'text-2xl font-semibold text-foreground tabular-nums', note: 'KPI 统计卡' },
  { file: '/components/harness/HarnessLoginDialog.tsx', marker: 'tabular-nums', note: '设备登录倒计时' },
  { file: '/components/session/InteractionCard.tsx', marker: 'tabular-nums', note: '交互卡片倒计时' },
  { file: '/components/session/UsageCard.tsx', marker: 'tabular-nums', note: 'Token / 费用用量' },
  { file: '/components/settings/ModelItem.tsx', marker: 'tabular-nums', note: '模型最长上下文' },
  { file: '/components/session/preview/ReviewPanel.tsx', marker: 'tabular-nums', note: '评审文件计数/行号' },
  { file: '/components/workflow/graph/WorkflowNodeCard.tsx', marker: 'tabular-nums', note: '节点进度计数' },
  { file: '/components/workflow/graph/ResourceChip.tsx', marker: 'tabular-nums', note: 'PR/Issue 数值徽标' },
  { file: '/components/workflow/NodeDetailDrawer.tsx', marker: 'tabular-nums', note: '节点详情数值列' },
  { file: '/components/sidebar/SidebarSection.tsx', marker: 'tabular-nums', note: '侧栏计数徽章' },
  { file: '/components/tree/TreeSection.tsx', marker: 'tabular-nums', note: '树计数徽章' },
  { file: '/components/knowledge-base/RepoKnowledgeBaseSection.tsx', marker: 'tabular-nums', note: '知识库文档计数' },
  { file: '/components/ui/badge.tsx', marker: 'tabular-nums', note: '计数徽标基类' },
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

  it('T-UIUX-COLOR: 禁止硬编码调色板色值，必须使用语义 Token（规范 §2）', () => {
    const violations: string[] = [];
    for (const [filePath, content] of Object.entries(agentWebSources)) {
      if (HARDCODED_COLOR_EXEMPT.some((exempt) => filePath.endsWith(exempt))) continue;
      const matches = content.match(HARDCODED_COLOR_REGEX);
      if (matches) {
        violations.push(`${filePath}: ${[...new Set(matches)].join(', ')}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('T-UIUX-TABULAR: 金额/Token/倒计时/计数徽标/表格数值列容器必须使用 tabular-nums（D4 清单式）', () => {
    const missing: string[] = [];
    for (const { file, marker, note } of TABULAR_CHECKLIST) {
      const source = findSource(file);
      if (!source) {
        missing.push(`${file}（文件缺失：${note}）`);
        continue;
      }
      if (!source.includes('tabular-nums')) {
        missing.push(`${file}（缺少 tabular-nums：${note}）`);
        continue;
      }
      if (marker !== 'tabular-nums' && !source.includes(marker)) {
        missing.push(`${file}（数值容器缺少「${marker}」：${note}）`);
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
