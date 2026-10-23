# admin-web

## Tech Stack

- **Framework**: React 19+ with TypeScript (strict mode)
- **Build Tool**: Vite
- **Styling**: Tailwind CSS v4
- **GraphQL Client**: Apollo Client 4
- **Routing**: React Router v7
- **Testing**: Vitest + React Testing Library

## Dev Commands

```bash
npm install
npm run build    # tsc -b && vite build
npm run lint
npm test
npm run preview
```

本项目由 Aspire 编排启动，无需单独运行 `npm run dev`；单独开发时 Vite dev 代理 `/graphql` → `http://localhost:10003`。

## 认证与路由

- 登录态持久化在 `localStorage`（`admin_token` / `admin_user`），不使用 cookie（计划期裁决 8）。
- 路由：`/login`、`/change-password`（无侧边栏）、受保护布局 `AdminLayout` 下 `/models`（默认）、`/base-images`、`/cloud-containers` 与 `/cloud-workloads`。
- 「云端容器」页（`/cloud-containers`）：展示 cloud-controller 管理的工作容器（名称/状态/用途/关联对象/创建时间/在线时长），`useQuery` 10s 轮询刷新；「启动」对话框本期仅提供 `idle` 任务，并可多选挂载「工作负载」（默认不选，勾选顺序即提交顺序，**最多 10 个**；工作负载列表加载中/失败分别展示「加载中」与「错误 + 重试」，避免误判为空）；每行「强制销毁」二次确认。状态展示映射见裁决 4（创建中/连接中/**初始化中**/在线/销毁中/已退出/失败），初始化中展示当前执行的工作负载脚本名（`currentWorkloadName`）；在线时长按裁决 15 前端计算（`lib/format.ts` 的 `formatOnlineDuration`）。控制面离线时保留降级数据并提示。
- 「工作负载」页（`/cloud-workloads`）：工作负载 CRUD（名称 + 初始化脚本 + 清理脚本 + 参数表单 + 依赖），新建/编辑共用对话框，删除二次确认。脚本摘要单行截断；前端预校验「名称必填且 ≤64 字符、两脚本至少其一非空、单脚本 ≤16 KiB」（服务端仍强制）。**参数设计器**（`ParamSchemaEditor`）支持四种字段类型（下拉单选/下拉多选/文本/布尔），可增删排序、编辑可选项、随类型切换默认值控件；可选项输入框**本地保留草稿文本**（逐字符键入不丢换行/行内空格），可选项变化时把默认值裁剪到当前可选项集合（避免失效默认值造成无法自救的校验死锁）；前端预校验与服务端同口径（key 正则/唯一、label 1~64、可选项 1~50 去重非空、默认值必填且合法），服务端仍是唯一事实源。**依赖选择器**为多选（0~5、排除自身、保存前依赖环提示）。列表展示「预制」徽章、`workloadKind` 分类徽章（STANDARD/HARNESS，缺省按 STANDARD）、参数数量、依赖名称，无值显示「-」。
- 云端容器启动对话框（`StartContainerDialog`）：工作负载按 `workloadKind` 分组渲染（「运行环境（standard）」/「云电脑（harness）」，空组不渲染标题；`workloadKind` 缺失按 `STANDARD` 兜底），选择/必选/参数/计划预览逻辑完全复用。选中带参数的工作负载展开参数表单（`WorkloadParamsForm`，默认值预填、以「键是否存在」判定是否填写，避免 `false`/空串被误判）；带依赖的工作负载展示「将自动初始化 XXX、YYY（默认参数）」提示；展示最终初始化顺序预览（`lib/workload-plan.ts` 纯函数，仅预览，最终以服务端下发的计划为准）；**依赖环或依赖不存在时前端拦截启动**（避免必然被服务端拒绝）；多选参数按可选项顺序归一（快照稳定）；提交 `workloads[]`（含 `params`）。**「必须」开关（工作负载三期）**：仅「已勾选且含 `initScript`（trim 后非空）」的工作负载展示「必须」开关（默认关，可独立设置多个）；取消勾选时清除其必须设置、重新勾选回到默认非必须；顺序预览对必须项加「必须」标识（隐式依赖不受影响）；提交时仅对必须项携带 `required=true`（非必须项省略 = 缺省 false）；说明行「标记为必须的工作负载初始化失败将导致容器被强制注销」。前端只做展示与提交，**不做本地硬失败预判**。
- 工作负载执行日志：在「云端容器」页按容器查看（`WorkloadLogsDialog`）——执行记录列表（工作负载/阶段/状态/时间，`required=true` 记录展示「必须」标识，历史缺省不误标）+ 选中项的**参数快照**、脚本内容快照与输出日志（历史无 `params` 显示「-」）。日志查询 `pollInterval: 5000` 并带「刷新」按钮（PRD 功能点 5：执行中记录实时可刷新），轮询按 `id` 保留用户选中项；对话框自带 `useQuery`，与容器 10s 轮询解耦（轮询刷新不打断已打开对话框）。
- `ProtectedRoute`：未登录 → `/login`；`mustChangePassword` → `/change-password`（后端业务 resolver 亦有双保险拦截）。
- 数据加载分支一律写 `loading && !data`，避免 Apollo v4 轮询卸载整页（见 `frontend-rules.md`）。
- 「模型配置」页的模型管理：新增供应商**不自动导入模型**（成功 toast 提示通过「导入模型」手动导入）；供应商操作菜单「导入模型」打开弹窗拉取上游清单（已导入/已被其他供应商占用禁选、可全选当前过滤结果、失败可重试）；「可用模型」按供应商分组并默认折叠，拖拽仅限组内、保存提交全量 id；任意模型可删除（含导入模型，确认文案含「按该模型名调用将返回「模型不存在」」）；自定义模型名在提交前做本地重名预检（全局唯一）；「重名整理记录」为只读折叠区块，展开才查询（迁移 005 台账）。
- 组件从 agent-web 复制后独立演进，**禁止跨项目 import**。

## TDD Workflow

本项目采用测试驱动开发（TDD）模式，遵循红-绿-重构循环。详细指南参考 [TDD Skill](../../.agents/skills/tdd/SKILL.md)。

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
- [Frontend Rules](../../docs/engineering/frontend-rules.md)

## 云容器优化二期（模型最长上下文）

- 模型条目展示「最长上下文：N tokens / 未设置」并提供铅笔编辑入口（`aria-label=编辑模型`）。
- `CustomModelDialog` 支持新增与编辑：编辑模式供应商/名称只读，仅可修改/清空「最长上下文大小（token）」；留空提交 `null` 表示未设置，非正整数前端提示「请输入正整数」，服务端为唯一事实源。
- 新增 `UPDATE_MODEL_CONTEXT_LENGTH` mutation；`ADMIN_MODELS` 查询选择集包含 `contextLength`。
