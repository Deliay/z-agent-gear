# Engineering 文档管理

本文档描述了 `docs/engineering/` 目录下的技术文档管理规范。

## 目录结构

```
engineering/
├── AGENTS.md             # 本文件：目录规范说明
├── common-rules.md       # 通用开发规范
├── backend-rules.md      # 后端开发规范
├── frontend-rules.md     # 前端开发规范
├── proposals/            # 技术提案（评审后锁定）
├── plan/                 # 实现计划（从 proposal 拆解出的可执行任务）
└── acceptance/           # 验收报告（含 archived/ 归档子目录，规范见 acceptance/AGENTS.md）
```

## 文件命名规范

遵循 [[../../.agents/skills/z-document/SKILL.md|z-document]] 标准：

```
{YYYYMMDD}-{feat|fix|refactor}-{slug}.md
```

- **日期**: 使用创建日期，格式 `YYYYMMDD`（如 `20260521-`）
- **类型**: 类型前缀，`feat`（新功能）、`fix`（修复）、`refactor`（重构）
- **标题**: 类型之后紧跟，使用连字符分隔

示例：`20260521-feat-acp-session-sync.md`

## 文档结构

每个技术提案（proposal）应包含 YAML front matter：

```markdown
---
description: 简短说明此技术提案的用途
type: Permanent
---

# 标题 - 技术提案

**功能名称**: ...
**关联 PRD**: ...
**技术提案版本**: v1.0
**创建日期**: YYYY-MM-DD
**作者**: ...
**feat-branch**: `feat/<slug>`

## 1. 概述

### 1.1 背景
### 1.2 目标
### 1.3 范围

## 2. 技术架构

### 2.1 系统架构图
### 2.2 技术栈
### 2.3 模块划分

## 3. API 设计

### 3.1 API 契约
### 3.2 内部接口

## 4. 数据模型

### 4.1 数据库设计
### 4.2 缓存设计

## 5. 技术实现方案

### 5.1 核心流程
### 5.2 关键实现点

## 6. 技术决策

### 6.1 决策列表
### 6.2 依赖与约束

## 7. 项目结构

## 8. 测试策略

## 9. 验收标准

## 10. 相关文档
```

技术提案中允许包含详细的技术细节（项目结构、API 设计、数据模型等），必须使用 Mermaid 图形描述流程和架构。

## 工作流程

```mermaid
flowchart LR
    P[产品 PRD Review 通过] --> T[编写技术提案]
    T --> R[Review 技术提案]
    R -->|通过| C[更新 API Contract]
    C --> I[编码实现]
    I --> E[编排 + 测试]
    E --> M[合并入主干]
```

### 创建提案

1. 加载 `z-coding` skill
2. 加载产品文档，理解需求
3. 创建文件到 `proposals/` 目录，以创建日期为 ID
4. 完成后发起 Review

### 修改提案

1. 直接编辑对应文件
2. 更新版本号
3. 记录变更原因

## Skill 参考

| Skill | 用途 |
|-------|------|
| [[../../.agents/skills/z-coding/SKILL.md\|z-coding]] | 契约式开发全流程 |
| [[../../.agents/skills/z-document/SKILL.md\|z-document]] | 文档格式与命名规范 |
| [[../../.agents/skills/z-test/SKILL.md\|z-test]] | API 测试与 E2E 测试 |
| [[../../.agents/skills/z-aspire-orchestrator/SKILL.md\|z-aspire-orchestrator]] | 服务编排 |
| [[../../.agents/skills/tdd/SKILL.md\|tdd]] | 测试驱动开发（红-绿-重构循环） |

## 相关文档

### 规范文件

- [[common-rules.md]] — 通用开发规范
- [[backend-rules.md]] — 后端开发规范
- [[frontend-rules.md]] — 前端开发规范

### 技术提案（`proposals/`）

- [[proposals/20260517-feat-agent-controller-v1.md]] — Agent 控制器管理 v1
- [[proposals/20260517-feat-llm-provider-settings.md]] — LLM 供应商与模型管理
- [[proposals/20260517-feat-user-auth-and-settings.md]] — 用户认证与设置页
- [[proposals/20260518-feat-agent-session.md]] — Agent 拉起与交互
- [[proposals/20260519-feat-local-controller-workspace-management.md]] — 本地控制器工作区管理
- [[proposals/20260519-feat-test-coverage-agent-session.md]] — Session 测试覆盖
- [[proposals/20260519-fix-acceptance-issues.md]] — 验收问题分析与修复
- [[proposals/20260519-fix-acp-rendering.md]] — ACP 消息渲染改造
- [[proposals/20260519-fix-acp-session-init.md]] — ACP Session 初始化修复
- [[proposals/20260519-fix-frontend-acp-response.md]] — 前端 ACP 会话修复
- [[proposals/20260520-feat-session-reopen.md]] — Session Re-open
- [[proposals/20260520-refactor-controller-acp-sdk.md]] — ACP SDK 重构
- [[proposals/20260521-feat-acp-session-sync.md]] — 工作目录历史会话同步
- [[proposals/20260522-feat-available-models-and-mode-switch.md]] — 可用模型与模式切换
- [[proposals/20260522-feat-local-controller-config-page.md]] — 本地控制器配置页
- [[proposals/20260522-feat-model-switch-support.md]] — 模型切换支持
- [[proposals/20260523-feat-git-worktree-support.md]] — Git Worktree 支持
- [[proposals/20260523-feat-workspace-git-support.md]] — 工作区 Git 支持
- [[proposals/20260524-feat-docker-compose-support.md]] — Aspire Docker Compose 集成
- [[proposals/20260524-feat-session-message-history-optimization.md]] — 会话消息历史优化
- [[proposals/20260526-feat-multi-acp-server-support.md]] — 多 ACP Server 支持
- [[proposals/20260526-fix-acceptance-session-state.md]] — 验收 Session 状态修复
- [[proposals/20260526-proposal-ui-optimization.md]] — UI 优化一期
- [[proposals/20260526-proposal-ui-optimization-phase2.md]] — UI 优化二期
- [[proposals/20260527-feat-mobile-layout.md]] — 移动端布局
- [[proposals/20260527-feat-port-forwarding.md]] — 本地 Agent 控制器端口转发
- [[proposals/20260527-feat-unified-agent-status.md]] — 统一 Agent 状态
- [[proposals/20260527-fix-acp-server-windows-launch.md]] — ACP Server Windows 启动修复
- [[proposals/20260528-feat-acp-permission-reminder.md]] — ACP 授权提醒
- [[proposals/20260528-proposal-ui-optimization-phase3.md]] — UI 优化三期
- [[proposals/20260529-command-mode.md]] — 命令模式
- [[proposals/20260529-feat-dark-mode.md]] — 黑暗模式
- [[proposals/20260530-feat-mcp-proxy-config.md]] — MCP 代理服务配置
- [[proposals/20260705-feat-acp-server-extend.md]] — ACP Server 支持扩展
- [[proposals/20260721-refactor-frontend-design-overhaul.md]] — 整体前端设计优化（设计语言升级与视觉重构）
- [[proposals/20260803-feat-acp-v1-completion.md]] — ACP v1 协议补全与展示优化
- [[proposals/20260829-fix-workflow-worktree-session-start.md]] — 工作流 Worktree 节点会话启动失败修复
- [[proposals/20260907-feat-experience-optimization-phase1.md]] — 综合体验优化一期
- [[proposals/20260908-feat-frontend-auto-select-server.md]] — 前端支持服务器自动选择
- [[proposals/20260829-refactor-mcp-controller-proxy.md]] — MCP 传递重构一期（控制器代理 MCP 访问）
- [[proposals/20261008-feat-domestic-api-acceleration.md]] — Web 国内加速 API 接入（Controller API 自动选择）
- [[proposals/20261013-feat-unified-home-display.md]] — 首页展示优化
- [[proposals/20261014-feat-admin-console.md]] — 云控制器管理后台一期
- [[proposals/20261014-feat-cloud-agent-phase2.md]] — 云Agent二期（K8s 云端工作容器）
- [[proposals/20261017-feat-cloud-controller-workload.md]] — 云控制器工作负载功能
- [[proposals/20261018-feat-workload-phase1.md]] — 工作负载一期（参数、依赖与预制工作负载）
- [[proposals/20261018-feat-workload-phase3.md]] — 工作负载三期（必须工作负载硬失败与 .NET 安装优化）
- [[proposals/20261018-feat-workload-phase4.md]] — 工作负载四期（worker 基础镜像瘦身）
- [[proposals/20261018-fix-docker-ce-apt-source.md]] — Docker CE 软件源地址补齐（修复 Docker 工作负载初始化必然失败）
- [[proposals/20261019-feat-aspire-workload-proxy.md]] — Aspire 工作负载下载代理（Aspire CLI 内网代理下载）
- [[proposals/20261017-feat-controller-version-requirement.md]] — 云端工作容器控制器版本门禁与自升级
- [[proposals/20261018-feat-credits-billing.md]] — 费用中心（Credits 计费）
- [[proposals/20261020-fix-api-channel-model-fixes.md]] — 内建API渠道一期上线后问题修复（供应商与模型管理）
- [[proposals/20261021-feat-acp-protocol-enhancement.md]] — ACP 协议增强（能力透明化与模型来源分组）
- [[proposals/20261021-feat-acp-protocol-enhancement-opencode-support.md]] — ACP 协议增强调研附录：OpenCode ACP 支持清单
- [[proposals/20261021-feat-github-workload.md]] — Github 工作负载与云主机 Git 项目设置（Github 预制工作负载、拉起后安装与 MCP 开放、最小化凭据 clone 并自动建会话）
- [[proposals/20261020-feat-container-harness-support.md]] — 容器启动任务支持 harness 类型（OpenCode 云电脑，v5.0 停止即销毁/会话只读/每用户 1 实例；会话导入导出与统一存储二期）
- [[proposals/20261022-feat-workload-optimization.md]] — 工作负载优化（云电脑创建/展示支持 standard 负载与 MCP 列出安装，Github 项目 clone 地址前缀拼接）
- [[proposals/20261022-feat-cloud-container-optimization-phase1.md]] — 云容器优化一期（会话/工作流「+」列表实时刷新、云电脑创建前端编排 Github 项目准备并复用工作负载进度框、默认 MCP 注入与控制器默认 MCP、CreateSessionInput 前置 modeId/modelId 与选项 5 分钟缓存/失效/刷新）
- [[proposals/20261023-feat-workflow-github-pr-callback.md]] — 工作流 GitHub Pull Request 联动（linkPullRequest MCP 工具与 PR Handler Registry、人类节点「联动上游 Pull Request」、工作流追加提示词 key 去重、事件回调按 review 状态驱动人类节点完成/打回）
- [[proposals/20261023-feat-cloud-container-optimization-phase2.md]] — 云容器优化二期（创建期不预置默认工作区：仅「Git 项目设置」初始化 Github 项目才创建工作区、Model.contextLength 后台模型最长上下文并经 OpenAI 兼容 /v1/models 的 context_length 下发、云电脑 Job 模板 ephemeral-storage 上限 10Gi）
- [[proposals/20261025-fix-opencode-model-context-length.md]] — 云电脑 OpenCode 模型上下文长度下发修复（secrets.modelContextLengths → ZAG_MODEL_CONTEXT_LENGTHS → opencode models.limit.context）
- [[proposals/20261025-feat-kimi-code-harness.md]] — 增加工作负载「Kimi Code」（Harness）（harnessTypes 扩展 kimi_code 与预置工作负载 009、agent-gear 2.8.0 kimi 登录闸门 `kimi login` stdio 判定、harness:login 事件族与登录引导弹窗、按 harnessTypes 细分版本门禁）
- [[proposals/20261025-feat-deepseek-harness.md]] — 增加工作负载「DeepSeek Harness」（Harness）（harnessTypes 扩展 deepseek_harness 与预置工作负载 010 双包固定版本安装、agent-gear 2.9.0 harness prepare 按 ZAG_HARNESS_TYPES 分流、平台渠道模型注入 profiles/acp/cordis.patch.yml providers.zag + .credentials.yaml refs 与默认路由覆写含实测验证、按 harnessTypes 细分版本门禁）
- [[proposals/20261025-feat-github-native-webhook.md]] — GitHub 原生 Webhook 入口（POST /api/events/github/webhook 直连 pull_request_review，HMAC-SHA256 验签后归一化复用 PR 联动判定链）
- [[proposals/20261025-fix-cloud-container-active-deadline.md]] — 云电脑取消 Job 最长运行时间限制（移除 activeDeadlineSeconds，expiresAt 仅落库留存）
- [[proposals/20261025-feat-cloud-host-keepalive.md]] — 云电脑保活与 worker 用户（entrypoint 无限保活循环每轮自更新 + 服务端终止退出码 42；nvm/Node/agent-gear 下放 worker 用户 per-user nvm 安装、root 环境无 nodejs、setpriv 降权并显式构造 worker 环境、免密 sudo、预置脚本 sudo 化与 /home/worker 路径迁移、harness 版本门禁提升）
- [[proposals/20261025-feat-github-issues-workflow.md]] — 云电脑 GitHub Issues 联动工作流（CloudHostIssuesLinkage 多配置列表 + 自定义标签 start-{工作流名字} + IssueWorkflowTrigger 状态机、github-webhook 扩展 issues 事件、ensureIssueLabel/deleteIssueLabel/createIssueComment、销毁云电脑 cleanup 标签清理、复用 Git 项目设置编排与 completeHumanNode 完成首个人类节点）
- [[proposals/20261025-feat-workflow-check-runs-sync.md]] — 工作流节点状态通过 GitHub Check Runs 同步（引擎 onNodesTransitioned hook、Checks REST 客户端与 checks:write 权限、stale 编排、session:message 中央订阅 todo panel 同步 check-run 子项）
- [[proposals/20261026-fix-cloud-host-key-lifecycle.md]] — 云电脑 LLM API Key 随容器回收（取消 24h 固定有效期，宿主非 RUNNING/删除/缺失即失效，迁移清理存量有效期）
- [[proposals/20261026-fix-issues-workflow-force-worktree.md]] — GitHub Issues 联动工作流强制 Worktree 隔离（IssuesTriggerRunner 实例化强制 createWorkflowWorktree:true；新增默认分支解析器——GitHub 项目经 GitHub API 获取回填、否则按 main/master/release 顺序经 git:check 探测回填，并接入 instantiate 修复 defaultBranch 缺失即 fast fail/静默跳过的历史问题；节点级隔离语义不变）
- [[proposals/20261026-fix-default-workspace-optimization.md]] — 默认工作区优化（Git 项目设置 clone 成功后无条件 ensureWorkspace 并 CAS 回写 workspaceId、Github 项目设置入口迁至云电脑配置 Github 页签、前缀地址默认 ~/workspace 并支持 ~ 展开为容器主目录）
- [[proposals/20261027-feat-unlimited-cloud-hosts.md]] — 用户开放无限制云电脑支持（创建同步扣费 5 credits：`/internal/billing/charges` 一次性扣费 + 拉起失败退款、`cloudHostBillingQuote` 报价透出、移除每用户 1 实例门禁与 `uniq_active_cloud_host_per_user` 索引、`CloudHost.githubAccountId` 锁定：创建可选/首次设置 CAS 绑定/之后不可改）
- [[proposals/20261027-feat-commit-author-settings.md]] — 云容器 Commit 提交人设置（user_commit_settings 用户级设置与 commitSettings/updateCommitSettings 契约、POST /internal/cloud-hosts/:id/commit-identity 身份下发端点与 agent_only 负载门控、agent-gear 容器内 include.path 托管 git 配置 + Co-Author prepare-commit-msg hook、未设置零残留）
- [[proposals/20261027-feat-dsh-header-masq.md]] — DeepSeek Harness 会话标识请求头注入（dsh-header-masq 插件：预置脚本 V4 固定版本 0.1.2-alpha.2 → 0.2.1-rc.2 + `dsh plugin --profile acp add Deliay/dsh-header-masq`、agent-gear 2.11.0 dsh-config insert 形态第 5 受管条目、migration 013 存量刷新、deepseek_harness 版本门禁 2.9.0 → 2.11.0）
- [[proposals/20261027-feat-multi-tenant-phase1.md]] — 多租户一期（三层帐号模型：accounts 独立承载登录不 ref User、users+tenantId/accountId 承载 tenant→users 与 account→users 一对多且暂保留原登录字段、tenants 无成员列表且 personal 租户 _id 复用 userId 一期单成员；迁移 012 三件套拆分只复制不删除/013 复制清洗 tenantId（保留 userId 筛选、查询 tenantId+userId 双条件、上线前行为不变）/014 计费 ownerType front_user→tenant 余额零改动且兼容 admin_user 双 owner；后台不做多租户设计；契约删 signup 前台硬关注册；agent-api `/internal/users` 开户内部端点保有写权；admin-api 租户只读管理与后台开户；cloud-controller cloudcontainers 补 tenantId；启动自检轻量异步）
- [[proposals/20261028-refactor-conversation-rendering.md]] — 重构对话渲染（纯前端渲染层重构：tool-call-state 多消息三态合并修复完成后退化 Tool Call: other、CodeBlock 工具栏复制/换行/语言标签、MermaidBlock 动态导入懒加载渲染与失败回退、jsdiff 真实差异 + 行号 + Prism 逐行高亮、ansi-to-html 终端颜色渲染、ToolCall 图标体系与 rawInput 折叠 + ContentBlock 全类型、消息复制与对话导出 Markdown、IntersectionObserver 滚动跟随暂停/恢复与回到底部、PlanCard 删除线与计数口径）
- [[proposals/20261028-feat-multi-tenant-phase2.md]] — 多租户二期（tenantmembers 含 role 两级 admin/developer、personal 恒 admin 与 last-admin 保护；workspaces/workspacemembers 建模、全局工作区无成员行、每租户恰一个全局工作区部分唯一索引；权限矩阵：admin 全工作区可见可管+建工作区+帐号搜索加成员+角色变更，developer 仅成员工作区读写+全局只读（context.readOnly 插件统一写拦截）；11 资源集合复制新增 workspaceId 且可见性切工作区+角色判定；x-workspace-id 头解析缺省回退个人全局；providers/models 存量 scope=user 按租户复制入全局后删除原件；user_commit_settings 键改 workspaceId 与三段继承；计费 owner=workspace.tenantId；/internal/tenants team 开通与成员初始化含角色、cloudcontainers 补 workspaceId 迁移 002）
- [[proposals/20261028-feat-mongodb-workload.md]] — 增加工作负载「MongoDB」（admin-api 迁移 016 预置标准工作负载 presetKey=mongodb、init 脚本 012 sudo 正典形态原生 apt 经内网 Nexus 代理安装 mongodb-org 8.0、mongod --version 硬校验且不拉起实例、全链路数据驱动零协议改动、预制项测试断言 9→10）
- [[proposals/20261028-feat-playwright-workload.md]] — 增加工作负载「Playwright」（预制工作负载 015-preset-playwright：`npm install -g playwright` + `playwright install` 走内网 playwright-proxy、playwright_download_host 参数化与 env 覆盖、幂等锚点 + 结尾硬校验、依赖 Node.js 隐式展开、API/E2E 预制口径 8→9）
- [[proposals/20261029-feat-interrupted-call-token-billing.md]] — 调用中断的 token 计费优化（`model_call.aborted` 输入 token 按 20% 未缓存 + 80% 缓存拆分计价、输出全价：`usage-split.ts` 拆分唯一源 + metering `dims` 固化拆分保重放一致 + billing-service 定价口径替换与回写事实修正 + 网关 finalize 成本同口径、契约零结构变更仅口径描述）
- [[proposals/20261030-feat-ui-optimization-phase4.md]] — UI 优化四期（侧边栏与工作流视图）（agent-web 纯前端零契约变更：Sidebar 四折叠分区 + 跨环境聚合 + SidebarResizer 拖拽调宽 + TreeSection 空态收敛、WorkflowInstanceCard 两行卡片、WorkflowGraphView dagre TB + WorkflowNodeCard/ResourceChip 自定义节点 + useNodeSessionActivity 实时动态行、ui/sheet 节点与资源详情抽屉、状态语义配色单一来源与箭头连线）
- [[proposals/20261029-feat-pnpm-workload-and-harness-optional.md]] — 云电脑组件安装切换 pnpm 与工作负载 Harness 可选化（entrypoint 预装 pnpm@9.15.9 并接线 PNPM_HOME、迁移 017 字节匹配刷新 006/009/013/015 四脚本 `npm install -g`→`pnpm add -g` 含缺失自举回退、agent-gear 与 001 自举保持 npm；设置-工作负载与 MCP 暴露 harness（catalog listAll、createInstallOperation 放行、runtime 批次注入 harness env、逐类型版本门禁、appendInstalledWorkload 追加 harnessTypes）；harness 可选化（parseHarnessTypes 允许 0 个、创建计划 required=true→false、A.2.2 放宽））
- [[proposals/20261029-feat-commit-author-settings-optimization.md]] — Commit 作者设置优化（user_commit_settings 键回归 userId 成员独立并移除 CommitterMode/GITHUB_ACCOUNT 与三段继承、迁移 017 github_account→custom 等价转换+归属重键+索引先建后删、commit-identity 端点恒 bot 保留 mode 包络、`git:worktree:add` 扩展 committer 三段透传与 WorktreeHandler `extensions.worktreeConfig` + `--worktree` user 写入、issues webhook sender 捕获与 `WorkflowInstance.worktreeCommitter` 快照（触发人优先级：提交人设置→GitHub 身份→bot）、agent-web「Git」区块 + 导入Github帐号信息弹窗（personalGithubAccounts）、agent-gear 2.12.0 与 harness 门禁提升）
- [[proposals/20261030-feat-unified-logging-and-otel.md]] — 规范化日志与全链路可观测性（单源 vendored 观测模块 + pino JSON 日志与 no-console 不变量、OTel NodeSDK 以入口首个 import 启动、auto-instrumentations 与手工 span 分工、W3C traceparent 经 HTTP/Socket.IO/Redis 封套/Job env 四通道传播、云电脑 Job `OTEL_*` 注入与 agent-gear 2.12.0 手动埋点、名单脱敏与审计例外、Aspire collector 编排）
- [[proposals/20261031-feat-commit-with-bot-coauthor.md]] — Commit 与 bot 共同提交（user_commit_settings 新增 commitWithBot、CommitSettings 契约扩展、resolveWorktreeCommitter 追加 bot user/noreply email、`git:worktree:add` committer 扩展 coAuthorName/coAuthorEmail 并在 instance/orchestrator/session/issues 快照透传、agent-gear 2.13.0 worktree 级 core.hooksPath + prepare-commit-msg 幂等 trailer、agent-web Git 区块勾选项）
- [[proposals/20261102-feat-cloud-storage.md]] — 云电脑支持申请存储（工作区级 cloudstorages 与迁移 020、cloud-controller PVC CRUD + Job 卷挂载 /home/worker 主目录/fsGroup/initContainer 恢复、entrypoint bootstrap_home 幂等自举与工作负载幂等标准（迁移 018）、destroy 后独立 archiver Job 压缩 .tar.gz2 原子替换写入每工作区 100Gi 归档 PVC 并释放源 PVC、状态机 IDLE/ATTACHED/ARCHIVING/ARCHIVED/DESTROYED/CREATE_FAILED、3 档 per_unit 小时计费 + 已归档半价 + storagebillingcursors + BillingCategory.storage、T-CS/T-CC/T-BOOT/T-WL/T-BILL/T-WEB/E2E 用例矩阵）
- [[proposals/20261103-feat-workflow-iteration.md]] — 工作流迭代（契约新增 renameWorkflowInstance、agent-api 实例改名与 agent-workflow-tools 新增 renameCurrentWorkflow 工具；agent-web 详情页改名入口、节点卡片动态行收敛为「正在思考」静态指示、WorkflowNodeCard 补 React Flow Handle 修复依赖连线不可见、详情抽屉 PR 区块前置、token 文案改「{} tokens」、tint 改不透明 bg-card、图表视图按执行中节点前后各 2 卡片窗口 fitView 自动居中）
- [[proposals/20261103-feat-workflow-node-interrupt-retry.md]] — 工作流节点中断处理迭代（中断自动重试 1→10 次 + 指数退避 0/1/2/4/8/16/30m 封顶、重试管线 close→resume→等待 idling→addMessage 带 5 分钟空闲超时、重试计划持久化 retryCount/nextRetryAt/retryPhase + 30s 周期扫描器抗进程重启、新状态 RETRY_FAILED 与事件 retryExhausted、restart/resumeFailed 开放来源、通用会话状态回调、迁移 021 fallbackSent→retryCount、check-run action_required 映射）
- [[proposals/20261104-feat-session-management-optimization.md]] — 会话管理优化（Session 新增 archivedAt 与 controllerWorkspaceId（迁移 022 建索引）、archiveSession/Session.archived/Session.readOnlyReason 与 homeOverview.archivedSessions 契约扩展、删除/清空工作区连带「先结束后归档」其下普通会话（精确 + cwd 前缀/worktree scope 回退匹配、排除节点会话、归档失败中止删除）、统一只读判定覆盖控制器缺失/工作区缺失/云电脑终态并接入 resume/sendSessionMessage/cancelGeneration、前端会话页归档按钮与侧边栏已归档分组、workspaceArchiveImpact 删除确认数量）
- [[proposals/20261105-feat-docker-registry-mirrors.md]] — 「Docker」工作负载取消镜像引用规范化 shim 改用 registry-mirrors（脚本 v5 删除 shim 装配、清理历史 shim、写 /etc/docker/daemon.json registry-mirrors 后再启动/重启 dockerd 并 docker info 硬校验；新增 docker_registry_mirrors 参数默认内网 Harbor 地址、DOCKER_REGISTRY_MIRRORS env 最高优先级；迁移 020 未定制刷新与幂等；地址为空=不配置加速合法语义；BUILD.md 验收口径同步）
- [[proposals/20261104-feat-cloud-storage-archive-optimization.md]] — 云存储归档优化（stopCloudHost 新增 archiveStorage 选项：不勾选时 cloud-controller 落 storageArchiveSkipped 跳过归档、存储 ATTACHED→IDLE 继续全价；云存储新增「归档/复原到归档/fork」：cloud-controller 存储级 archive/restore 端点 + cloudstorageoperations 台账（迁移 003）、agent-api 状态机 +RESTORING 与 restores 回调 + 迁移 022、前端停止对话框归档勾选与三操作入口）
- [[proposals/20261104-feat-tool-call-terminal-rendering.md]] — 会话窗口中工具调用展示优化（终端输出渲染：xterm-headless 完整终端仿真解析为最终画面行 + React 静态渲染替代 ansi-to-html 剥离式管线、光标/擦除/覆写语义正确收敛、深黑色主题调色板单一来源、移除 dangerouslySetInnerHTML 注入面、纯前端零契约变更）
- [[proposals/20261104-fix-github-project-setup-optimization.md]] — Github 项目设置优化（GITHUB_SETUP_SCRIPT 目录已存在分支重写：同仓库 remote 匹配直接复用不再 `git pull --ff-only`、空目录 `rmdir` 后续克隆、异仓库/非空目录/同名文件统一提示「目标目录已存在其他项目」、.git 残骸保守归冲突；T-CHG8 重写 + T-CHG9 真跑 bash 行为矩阵；契约注释增补）
- [[proposals/20261104-feat-mcp-valut-iteration.md]] — MCP+Valut 功能迭代（valutnamespaces/valutentries/valutrefs 三集合：AES-256-GCM 复用 CREDENTIAL_ENCRYPTION_KEY、明文不出服务端、refs 独立关联、namespace 全局唯一启动自检；workspaceAccess 复用落地「工作区」权限；custommcpservers 承载 HTTP 自定义 MCP none/bearer 与 Valut 联动删除级联；迁移 023 播种 manual；前端移除 MCP 代理入口；v1.1 评审返工——自定义 MCP 改平台代理转发：mcp-endpoint 会话密钥扩展 custom 作用域快照、custom-mcp-forwarder 服务端直连真实 endpoint 注入凭据、删除即按 id 实时校验 410 全端点失效；契约新增 valut.graphql/custom-mcp.graphql）
- [[proposals/20261104-fix-question-tool-multi-select.md]] — question 工具多选题呈现修复（纯前端：ElicitationDialog 识别 `type:array + items.anyOf` 渲染多选勾选组、提交按 Issue #445 以 `.join(',')` 回传 ACP，types.ts 补 anyOf 声明、enum/oneOf 数组提交形态不变，契约 §2.31 补值形态注记；T-QM1~5 组件单测 + E2E 真实 question schema 用例）
- [[proposals/20261105-feat-session-interaction-content-preview.md]] — 新版会话交互与内容预览（agent-web 预览子系统：CodePreview Monaco 本地打包行定位/DiffEditor/批注模式、HtmlPreview iframe 沙箱元素选择、MarkdownPreview sourcepos 原文映射，分屏三模式与宽度门控、实况跟随复用 mergeToolCallMessages（写=常开 Tab diff 聚焦、读=共享预览 Tab）、输入框附件式提示词片段；新增 fs:read-file 读取链路（agent-gear 白名单/controller-api relay/agent-api sessionFileContent）；平台 MCP agent-session-preview-tools review 工具全会话默认装配 + SessionReview 领域（PENDING→通过/驳回/仅评论、30min 等待器、close 自动取消、用户级 SSE）与侧边栏 Review 分区；sendSessionMessage.parts 有序多片段链路（resolver→addMessage 合并文本+metadata→bridge 有序 ContentBlock），MCP 转发按 serverName 放宽至 30 分钟）
- [[proposals/20261107-feat-workflow-template-project-persistence.md]] — 工作流模板项目持久化（仓库 .zag/workflow/templates/*.json 一文件一模板；agent-gear 2.18.0 新增 workflow-templates:scan 白名单子目录扫描事件经 controller-api 中继 Redis 结果键；agent-api repoWorkflowTemplates 查询（在线/版本门禁+逐文件 JSON.parse+validateTemplateGraph）与 configureRepoWorkflow 变更（复用全量图校验与 agentConfig 校验，ConfiguredWorkflow 扩展 sourceKind=REPO/sourceRepoPath/sourceWorkspaceId 存量零迁移）；cloud-host-service.delete 级联删除 REPO 来源配置；agent-web 云电脑「工作流」区块与新增工作目录后检测提示）
- [[proposals/20261112-feat-session-interaction-cards.md]] — 会话中的提问表单与权限审批作为会话内容出现（sessioninteractions 新集合状态机+history、respond* 权威切换、permission:resolved 新频道与 60s 时限口径统一、WorkflowInstance.pendingInteractionSessionIds、会话时间线 InteractionCard 与倒计时、弹窗降级通知、工作流列表/图形感叹号）
- [[proposals/20261113-feat-cloud-controller-operations-restriction.md]] — 设置中控制器的操作按钮优化（前端 ControllerListSection 对 type=cloud 隐藏「重命名/重新生成Key/解绑(删除)」按钮；agent-api 服务层 rename/unbind/regenerate 三处 cloud 拒绝且零副作用、resolver 白名单文案逐字透传；契约补齐 regenerateControllerKey 与拒绝说明）
- [[proposals/20261113-feat-cloud-agent-gear-auto-upgrade.md]] — 云环境 agent-gear 自动升级（worker 镜像 entrypoint 新增 auto_update_loop 周期自升级：10 分钟 pnpm view 检查、mkdir 互斥安装、agent.pid 标记 + SIGTERM 复用保活非 42 路径优雅重启、latest 回滚自动愈合；契约零变更，T-EP20~T-EP27 stub 用例）
- [[proposals/20261113-feat-oidc-github-oauth-login.md]] — 支持自定义 OIDC 登录和 GitHub OAuth 登录（admin-api 唯一写方 authproviders（OIDC 多条 + GitHub 单条，secret AES-256-GCM 不回显）；agent-api 统一 OAuth 回调唯一入口（openid-client + PKCE/nonce，GitHub state），前台 externallogins 自动开户复用 provisioning 抽取，后台 adminexternallogins 先绑定后登录经 admin-api 内部端点换票；前后台一次性 ticket 兑换登录；契约 auth/admin-auth/admin-auth-provider/auth-oauth.md）

### 实现计划（`plan/`）

- [[plan/20260522-feat-available-models-and-mode-switch.md]] — 可用模型与模式切换实现计划
- [[plan/20260522-feat-local-controller-config-page.md]] — 本地控制器配置页实现计划
- [[plan/20260523-feat-git-worktree-support.md]] — Git Worktree 支持实现计划
- [[plan/20260523-feat-workspace-git-support.md]] — 工作区 Git 支持实现计划
- [[plan/20260524-feat-session-message-history-optimization.md]] — 会话消息历史优化实现计划
- [[plan/20260526-feat-multi-acp-server-support.md]] — 多 ACP Server 支持实现计划
- [[plan/20260526-fix-acceptance-session-state.md]] — 验收 Session 状态修复实现计划
- [[plan/20260526-plan-ui-optimization.md]] — UI 优化一期实现计划
- [[plan/20260526-plan-ui-optimization-phase2.md]] — UI 优化二期实现计划
- [[plan/20260527-feat-port-forwarding.md]] — 本地 Agent 控制器端口转发实现计划
- [[plan/20260527-fix-acp-server-windows-launch.md]] — ACP Server Windows 启动修复实现计划
- [[plan/20260527-mobile-layout.md]] — 移动端布局实现计划
- [[plan/20260527-unified-agent-status.md]] — 统一 Agent 状态实现计划
- [[plan/20260528-feat-acp-permission-reminder.md]] — ACP 授权提醒实现计划
- [[plan/20260528-plan-ui-optimization-phase3.md]] — UI 优化三期实现计划
- [[plan/20260529-command-mode-implementation.md]] — 命令模式实现计划
- [[plan/20260529-feat-dark-mode.md]] — 黑暗模式实现计划
- [[plan/20260530-feat-mcp-proxy-config.md]] — MCP 代理服务配置实现计划
- [[plan/20260707-feat-unified-gateway.md]] — 统一网关实现计划
- [[plan/20260709-feat-github-account-binding.md]] — GitHub 帐号绑定实现计划
- [[plan/20260710-fix-gateway-dual-auth.md]] — 网关双重认证修复实现计划
- [[plan/20260721-feat-acp-mimo-kimi.md]] — ACP Server 支持 MiMo Code / Kimi Code CLI 实现计划
- [[plan/20260721-refactor-frontend-design-overhaul.md]] — 整体前端设计优化实现计划
- [[plan/20260723-feat-session-scroll-loading.md]] — Session 对话滚动加载实现计划
- [[plan/20260803-feat-acp-v1-completion.md]] — ACP v1 协议补全与展示优化实现计划
- [[plan/20260811-feat-agent-workflow-phase2.md]] — Agent 工作流二期（工作流管理与实例化机制完善）实现计划
- [[plan/20260817-feat-session-lifecycle-and-worktree-management.md]] — 会话生命周期与 Worktree 管理增强实现计划
- [[plan/20260821-feat-workflow-optimization.md]] — 工作流优化 0821 实现计划
- [[plan/20260829-fix-workflow-worktree-session-start.md]] — 工作流 Worktree 节点会话启动失败修复实现计划
- [[plan/20260829-refactor-mcp-controller-proxy.md]] — MCP 传递重构一期（控制器代理 MCP 访问）实现计划
- [[plan/20260907-feat-experience-optimization-phase1.md]] — 综合体验优化一期实现计划
- [[plan/20260908-feat-frontend-auto-select-server.md]] — 前端支持服务器自动选择实现计划
- [[plan/20261008-feat-domestic-api-acceleration.md]] — Web 国内加速 API 接入（Controller API 自动选择）实现计划
- [[plan/20261013-feat-unified-home-display.md]] — 首页展示优化实现计划
- [[plan/20261014-feat-admin-console.md]] — 云控制器管理后台一期实现计划
- [[plan/20261014-feat-cloud-agent-phase2.md]] — 云Agent二期（K8s 云端工作容器）实现计划
- [[plan/20261017-feat-cloud-controller-workload.md]] — 云控制器工作负载功能实现计划
- [[plan/20261017-feat-controller-version-requirement.md]] — 云端工作容器控制器版本门禁与自升级实现计划
- [[plan/20261018-feat-workload-phase1.md]] — 工作负载一期（参数、依赖与预制工作负载）实现计划
- [[plan/20261018-feat-workload-phase3.md]] — 工作负载三期（必须工作负载硬失败与 .NET 安装优化）实现计划
- [[plan/20261018-feat-workload-phase4.md]] — 工作负载四期（工作容器基础环境瘦身）实现计划
- [[plan/20261018-feat-credits-billing.md]] — 费用中心（Credits 计费）实现计划
- [[plan/20261018-fix-docker-ce-apt-source.md]] — Docker CE 软件源地址补齐（修复 Docker 工作负载初始化必然失败）实现计划
- [[plan/20261019-feat-aspire-workload-proxy.md]] — Aspire 工作负载下载代理（Aspire CLI 内网代理下载）实现计划
- [[plan/20261020-fix-api-channel-model-fixes.md]] — 内建API渠道一期上线后问题修复（供应商与模型管理）实现计划
- [[plan/20261021-feat-acp-protocol-enhancement.md]] — ACP 协议增强（能力透明化与模型来源分组）实现计划
- [[plan/20261020-feat-container-harness-support.md]] — 容器启动任务支持 harness 类型（OpenCode 云电脑，v3.0：前台交付/停止即销毁/会话只读/每用户 1 实例/harnessTypes 多选）实现计划
- [[plan/20261021-feat-github-workload.md]] — Github 工作负载与云主机 Git 项目设置（Github 预制工作负载、拉起后安装与 MCP 开放、云主机凭据管理器 clone 并自动建会话）实现计划
- [[plan/20261022-feat-workload-optimization.md]] — 工作负载优化（创建/展示支持 Aspire/Docker/.NET 与 MCP 列出安装，Github 项目 clone 地址前缀拼接）实现计划
- [[plan/20261022-feat-cloud-container-optimization-phase1.md]] — 云容器优化一期（「+」列表实时刷新、云电脑创建前端编排 Github 项目并复用进度框、默认 MCP 注入与控制器默认 MCP、前置 modeId/modelId 与选项 300s 缓存/失效/刷新）实现计划
- [[plan/20261023-feat-workflow-github-pr-callback.md]] — 工作流 GitHub Pull Request 联动（契约、PR Handler Registry 与迁移、追加提示词 key 去重、人类节点联动字段、linkPullRequest MCP 工具与生命周期注销、事件回调判定链与 review 驱动）实现计划
- [[plan/20261023-feat-cloud-container-optimization-phase2.md]] — 云容器优化二期（创建期不预置默认工作区、Model.contextLength 经 OpenAI 兼容 /v1/models 的 context_length 下发、ephemeral-storage 10Gi）实现计划
- [[plan/20261025-feat-kimi-code-harness.md]] — 增加工作负载「Kimi Code」（Harness）（HarnessType 扩展 KIMI_CODE 与预置工作负载 009、agent-gear 2.8.0 使用前登录闸门 `kimi login` stdio 判定、`harness:login` 事件族 + 用户级 SSE 即时弹窗、按 harnessTypes 细分版本门禁）实现计划
- [[plan/20261025-feat-github-issues-workflow.md]] — 云电脑 GitHub Issues 联动工作流（契约 CloudHostIssuesLinkage 多配置 + cleanup、issues 报文归一化与命中判定、IssueWorkflowTrigger 状态机（工作区准备→实例化→回评→首个人类节点自动完成）、deleteCloudHost 级联清理、agent-web Github 区块与销毁标签清理询问、T-GHIL*/T-GHI*/E2E-33+）实现计划
- [[plan/20261025-feat-workflow-check-runs-sync.md]] — 工作流节点状态通过 GitHub Check Runs 同步（契约同步字段、WorkflowPrHandler 同步字段、Checks 客户端与 checks:write 凭据、引擎 onNodesTransitioned hook 与 stale 编排、todo panel 中央订阅与子项同步、linkPullRequest 首同步、GraphQL 透出与前端展示、API/E2E 测试）实现计划
- [[plan/20261025-feat-deepseek-harness.md]] — 增加工作负载「DeepSeek Harness」（Harness）（HarnessType 扩展 DEEPSEEK_HARNESS 与预置工作负载 010 双包固定版本安装 + `dsh --version` 硬校验、agent-gear 2.9.0 `harness prepare` 按 `ZAG_HARNESS_TYPES` 分流、平台渠道模型注入 `profiles/acp/cordis.patch.yml` + `.credentials.yaml` refs 与默认路由覆写、ACP `deepseek_harness` 探测/拉起、按 harnessTypes 细分版本门禁 2.9.0）实现计划
- [[plan/20261026-fix-issues-workflow-force-worktree.md]] — GitHub Issues 联动工作流强制 Worktree 隔离实现计划（github.getRepoDefaultBranch + 默认分支解析器 workspace-default-branch.ts——GitHub 优先、[main,master,release] 探测、回填 ControllerWorkspace.defaultBranch；instance.instantiate 接入解析器修复 defaultBranch 缺失即 fast fail/静默跳过历史问题；IssuesTriggerRunner 强制 createWorkflowWorktree:true 与实例化前解析失败落 FAILED；TDD 用例 WDB1-WDB7 / T-GH10a-d / I5+I7-I9 / R-WT1-R-WT5）实现计划
- [[plan/20261025-feat-cloud-host-keepalive.md]] — 云电脑保活与 worker 用户实现计划（entrypoint 无限保活循环：退避 + 每轮自更新 + 退出码 42/1/0 三分分流与 setpriv 降权显式构造 env；agent-gear `EXIT_SERVER_SHUTDOWN=42` 与 `/home/worker/workspace`；Dockerfile worker 用户 per-user nvm + 免密 sudo + root 无 nodejs；admin-api 迁移 012（主分支已占用 011）预置脚本 sudo 化与 `dockerd -G worker`；harness 门禁 2.10.0）
- [[plan/20261026-fix-default-workspace-optimization.md]] — 默认工作区优化（Git 项目设置 clone 成功后无条件 `ensureWorkspace` 并 CAS 回写 workspaceId（多 Harness 不建会话场景修复）、Github 项目设置入口迁移至云电脑配置 Github 页签、前缀地址默认 `~/workspace` 并双端支持 `~` 展开为 `/home/worker`、契约注释修订与 API/E2E 测试）实现计划
- [[plan/20261027-feat-unlimited-cloud-hosts.md]] — 用户开放无限制云电脑支持实现计划（admin-api `/internal/billing/charges|refunds|price-quote` 一次性扣费 5 credits + 拉起失败 adjust 退款、agent-api 创建编排接入扣费退款并移除每用户 1 实例门禁与迁移 011 下线 `uniq_active_cloud_host_per_user`、`CloudHost.githubAccountId` 帐号锁定 CAS 首绑/异帐号拒绝、agent-web 收费详情区块与 Github 帐号置灰跟随、API/E2E 测试）
- [[plan/20261027-feat-commit-author-settings.md]] — 云容器 Commit 提交人设置（user_commit_settings 模型/迁移 011 与 commitSettings/updateCommitSettings 契约、commit-settings-service 校验白名单 + resolveCommitIdentity 五步门控与 bot 身份 Redis 缓存、POST /internal/cloud-hosts/:id/commit-identity 永不 404、agent-gear include.path 托管 git 配置 + Co-Author prepare-commit-msg hook 幂等应用/移除零残留、agent-web CommitSettingsSection、T-CI*/T-CIM*/API/E2E 测试）实现计划
- [[plan/20261027-feat-dsh-header-masq.md]] — DeepSeek Harness 会话标识请求头注入实现计划（migration 013 预置脚本 V4：固定版本 `0.1.2-alpha.2 → 0.2.1-rc.2` + `dsh plugin --profile acp add Deliay/dsh-header-masq` 硬校验、存量 V1/V2/V3 精确匹配刷新；agent-gear 2.11.0 `dsh-config.ts` insert 形态第 5 受管条目 `header-masq` 四键注入；`deepseek_harness` 版本门禁 `2.9.0 → 2.11.0` 与契约 5 处口径增补、worker 镜像 `agent-gear@2.11.x`）
- [[plan/20261027-feat-multi-tenant-phase1.md]] — 多租户一期实现计划（契约先行：auth 删 signup + User.name/tenant、admin-tenant 新增、billing×2 BillingOwnerType+tenant、cloud-controller-websocket 附录 A harness tenantId；agent-api 迁移 012 三件套拆分只复制不删除 / 013 带 userId 集合复制清洗 tenantId 且唯一索引保留 userId 维度、认证三层化 AuthContext.tenantId、19 集合查询 tenantId+userId 双条件、`POST /internal/users` 开户；admin-api 迁移 014 ownerType front_user→tenant 且 admin_user 零改动、租户只读镜像与 admin-tenant resolvers、新增 AGENT_API_URL；cloud-controller 迁移基建新建与 cloudcontainers 清洗；agent-web 硬关注册与 username→name；admin-web 租户页/开户/费用中心双 owner；T-MT 系列测试收口）
- [[plan/20261028-refactor-conversation-rendering.md]] — 重构对话渲染实现计划（纯前端 apps/agent-web：Phase 1 tool-call-state 三态合并修复完成后退化 Tool Call: other + 四卡片 props 切换 MergedToolCall、Phase 2 CodeBlock 工具栏/MermaidBlock 懒加载、Phase 3 jsdiff 真实差异 + 行号 + Prism 高亮、Phase 4 ansi-to-html 终端颜色、Phase 5 图标/rawInput 折叠/ContentBlockRenderer 全类型、Phase 6 消息复制与导出 Markdown、Phase 7 IntersectionObserver 滚动跟随与回到底部、Phase 8 PlanCard 删除线、Phase 9 session-rendering E2E 收口；含 11 项代码事实裁决与测试矩阵 T-MERGE/T-DIFF/T-ANSI/E2E-CR1~8）
- [[plan/20261028-feat-multi-tenant-phase2.md]] — 多租户二期实现计划 v1.2（v1.1 评审返工：增加租户成员管理与角色体系；v1.2 计划期补强：`/internal/users` 新开户补全局工作区+admin 成员行、providers/models `scope` 缺失行同口径复制、成员/角色变更审计留痕、失效工作区前端回退；契约先行：workspace 新增含 TenantRole/租户成员管理 + admin-tenant/llm/github/cloud-host/workflow 补工作区维度 + cloud-controller-websocket 附录 A +workspaceId；agent-api tenantmembers（含 role）/workspaces/workspacemembers 三集合与迁移 015（全局工作区→成员回填 personal 恒 admin→11 集合 backfill→providers/models 按租户复制计数门禁→user_commit_settings 键改与索引切换）、x-workspace-id 上下文（角色/只读判定 + 角色感知 workspace-scope 插件统一写拦截）与工作区 CRUD/成员管理（仅 admin）+ tenant-member-service（searchAccounts/租户成员增删/角色变更，last-admin 保护）、11 集合可见性切工作区+角色判定（共享型读=本∪全局、Commit 三段继承、计费 owner=workspace.tenantId）、`/internal/tenants` 内部端点（含 role）；admin-api 只读镜像与 team 转发；cloud-controller cloudcontainers +workspaceId 迁移 002；agent-web 工作区切换器（按角色过滤）/工作区管理页/租户成员管理页/来源徽标与只读收敛；admin-web team 租户管理（指定角色）；含 F1 workflow 域 `resourceWorkspaceId` 命名冲突裁决等 11 项代码事实裁决与 T-WS 角色两档/T-MIG15/T-TM/T-TT/兼容回归测试矩阵）
- [[plan/20261028-feat-mongodb-workload.md]] — 增加工作负载「MongoDB」实现计划（admin-api migration 016 播种 presetKey=mongodb 零参数零依赖预制项：012 sudo 正典形态 init 脚本内网 Nexus GPG/apt 源原生安装 mongodb-org 8.0 + `mongod --version` 硬校验不拉起实例；TDD 迁移单测 T-MIG-MDB1~MDB5、tests/api/e2e 预制项 9→10 收口、与并行 Playwright 需求迁移编号/计数断言 merge 协调裁决；015 已被 Playwright 占用按裁决 1 顺延）实现计划
- [[plan/20261028-feat-playwright-workload.md]] — 增加工作负载「Playwright」实现计划（admin-api migration 015-preset-playwright 播种预制工作负载：`PLAYWRIGHT_SCRIPT_V1` 幂等脚本承载 Issue #342 安装口径（`npm install -g playwright` + `PLAYWRIGHT_DOWNLOAD_HOST=... playwright install`）+ 结尾硬校验、`playwright_download_host` 参数化下载源三段取值优先级、Node.js 隐式依赖解析、tests/api 8→9 与 E2E T-E16 收口、迁移编号与并行 MongoDB 需求协调裁决；T-MIG-PW1~PW5）
- [[plan/20261029-feat-interrupted-call-token-billing.md]] — 调用中断的 token 计费优化实现计划（契约口径描述零结构变更；`usage-split.ts` 拆分唯一源 `splitAbortedInput` + metering `dims` 固化 `billedInput*` 保重放一致 + billing-service 定价口径替换与回写事实用量修正 + 网关 finalize 成本同口径；前端 `segmentLabel` 中断分段标签（裁决 1 修正提案「前端零改动」）；TDD T-AB1~8 / T-FE1~2 / API-AB1~2、11 项计划期裁决）
- [[plan/20261030-feat-ui-optimization-phase4.md]] — UI 优化四期（侧边栏与工作流视图）实现计划（纯前端 apps/agent-web 零契约变更：Phase 0 ui/sheet + harness-labels + useHumanNodeActions + 状态三段语义色、Phase 1 Sidebar 四折叠分区/跨环境聚合/SidebarResizer 拖拽调宽/TreeSection 空态收敛、Phase 2 WorkflowInstanceCard 两行卡片、Phase 3 dagre TB 竖向布局画布占满 + 加粗箭头连线、Phase 4 WorkflowNodeCard + useNodeSessionActivity 实时动态行与人类节点就地操作、Phase 5 ResourceChip 资源上图与归属、Phase 6 NodeDetailDrawer 节点/资源详情抽屉、Phase 7 状态配色主题收口、Phase 8 E2E-UI4S*/E2E-UI4G* 收口；含 12 项代码事实裁决与 12 项设计裁决）
- [[plan/20261029-feat-pnpm-workload-and-harness-optional.md]] — 云电脑组件安装切换 pnpm 与工作负载 Harness 可选化实现计划（契约注记修订 A.2.2/A.2.5 与 cloud-host.graphql 注释；entrypoint `ensure_pnpm` 预装 pnpm@9.15.9 + PNPM_HOME/WORKER_PATH/profile.d 接线（T-EP9/10）；admin-api migration 017 四脚本 `npm install -g`→`pnpm add -g` 字节匹配刷新含缺失自举回退（T-MIG-PN1~PN5）；agent-api catalog `listAll`/安装放行 harness/`parseHarnessTypes` 允许 0 个/计划 `required=false`（T-AH1~4）；cloud-controller runtime 批次 harness env/逐类型版本门禁/`appendInstalledWorkload` 追加 harnessTypes（T-CC-R1~4）；agent-web harness 分组「可选」徽标与创建去必选（T-WEB1~3）；tests/api、tests/e2e 口径收口）
- [[plan/20261031-feat-commit-with-bot-coauthor.md]] — Commit 与 bot 共同提交实现计划（commitWithBot 模型/服务归一、Worktree 提交人载荷与 WorkflowInstance 快照扩展、controller-api 透传、agent-gear worktree hook（T-WTC5~8）、agent-web 勾选项与 API/E2E 测试矩阵）
- [[plan/20261029-feat-commit-author-settings-optimization.md]] — Commit 作者设置优化实现计划（user_commit_settings 键回归 userId 成员独立并移除 CommitterMode/GITHUB_ACCOUNT 与三段继承、迁移 019 github_account→custom 等价转换+归属重键+索引先建后删、commit-settings-service 重写含 resolveWorktreeCommitter、commit-identity 端点恒 bot 保留 mode 包络、`git:worktree:add` committer 三段透传与 WorktreeHandler `extensions.worktreeConfig`+`--worktree` user 写入、issues webhook sender 捕获与 `WorkflowInstance.worktreeCommitter` 快照（触发人优先级：提交人→GitHub 身份→bot）、agent-web「Git」区块+导入Github帐号信息弹窗（personalGithubAccounts）、agent-gear 2.12.0 与 harness 门禁提升、API/E2E 测试；含 5 条代码现状差异与 8 条计划期裁决，迁移编号 017→019、runner 落点 issues-event-handler、worktree user shell 转义等）
- [[plan/20261102-feat-cloud-storage.md]] — 云电脑支持申请存储（云存储）实现计划（契约先行：新增 `contracts/cloud-storage.graphql` + `cloud-host.graphql` 的 `storageId/storage/storageRestoring` + `cloud-controller-websocket.md` 附录 A 存储端点和 `storage/restore/storageClass` + billing 双契约 `BillingCategory.storage`；Phase 2 worker 镜像 `bootstrap_home` 幂等自举与 `NVM_INSTALL_URL`/`NODE_VERSION` 运行时 ENV（T-EP15~18）；Phase 3 admin-api 三档价目 + `storage-quote`/`storage-charges` 独立出账 + `storage-tick` 按 `billingStartedAt` 桶锚点整点结算 + `storagebillingcursors` + 迁移 018 工作负载幂等字节匹配；Phase 4 cloud-controller PVC CRUD、Job `/home/worker` 挂载 + `fsGroup=1000` + initContainer 恢复、归档 Job 原子替换（`.tmp`→删旧→`mv`）与源 PVC 先删后回调、按工作区串行、用量 du Job、cleanup、archiver 镜像与 RBAC/env；Phase 5 agent-api `cloudstorages` 状态机（含 `attachFromStatus`）/权限/报价、云电脑挂载占用与回滚、归档/用量回调、迁移 020 与工作区删除保护 10→11；Phase 6 agent-web 设置-云存储与新建云电脑区块、费用分类；Phase 7 tests/api + tests/e2e 与内网验收；含 22 项计划期裁决、风险与回滚）
- [[plan/20261030-feat-unified-logging-and-otel.md]] — 规范化日志与全链路可观测性实现计划（契约先行：新增 `contracts/observability.md` + `cloud-controller-websocket.md` 附录 B（`_meta` 与 Job env 表）+ `agent-session-websocket.md`/`mcp-forward-redis.md` `_meta` 保留位；Phase 2 单源 `packages/observability/src` 7 文件（logger/log-context/trace/telemetry/register/http-context/testing，服务名与版本由 `package.json` 自解析故副本全等）+ `scripts/sync-observability.mjs` + 5 包 sha256 一致性测试 + 每包 `no-console` 不变量（先红）；Phase 3 cloud-controller 试点（删除 `src/logger.ts`、60 处 variadic `(msg,err)` 结构 logger 改 pino 原生签名、`buildHarnessJobEnv(options, containerId, traceparent)` 注入 `OTEL_*` + `ZAG_INIT_TRACEPARENT` + `zag.workspace.id`、entrypoint.sh 纯 printf JSON）；Phase 4/5/6 controller-api 175 / admin-api 112（含 billing 31 处 MqLogger）/ agent-api 175 处 console 全量替换与 `httpContext`（agent-api 挂在既有 `runWithRequestAuth` ALS 外层）、Redis `publishJson`（agent-api 39 / controller-api 20，RabbitMQ 5 处不改）、Socket.IO 握手与 `_meta` 传播、高频通道禁逐条 span；Phase 7 agent-gear 2.13.0 精简手动埋点（CLI 用户可见输出保留纯文本；v1.1：main 已发布 2.12.0，版本顺延）；Phase 8 前端 dev-gated；Phase 9 AppHost `otel-collector` + compose/k8s；Phase 10 规范与 AGENTS 索引（新建 `servers/admin-api/AGENTS.md`）；Phase 11 T-OBS1~T-OBS22 与 139 处 console spy 迁移（断言型 18 文件必改、静音型 41 文件可保留）；含 F1-F12 事实校正与 D1-D11 设计裁决、R1-R8 风险与回滚、命令参考与代码事实核对记录）
- [[plan/20261102-feat-controller-session-takeover.md]] — 云控制器重复登录新连接接管实现计划（controller-api `takeoverSession`/`releaseSession` Lua 原子接管与所有权释放、register 旧 socket `SESSION_REPLACED` 通知与断开、断线/注销所有权校验、心跳巡检逐条 CAS + 捕获所有权释放；agent-gear 识别 `SESSION_REPLACED` 不重连不清 Key 按 42 退出；契约 §2.2/§2.4/§3.3/§3.7 与 AGENTS 同步、T-ST1~T-ST15 测试矩阵、agent-gear 2.16.0 与 worker 镜像发布顺序）
- [[plan/20261103-feat-workflow-iteration.md]] — 工作流迭代实现计划（契约新增 `renameWorkflowInstance` + schema 双写；agent-api `normalizeWorkflowName`/`rename` 服务与 GraphQL resolver；`agent-workflow-tools` 新增 `renameCurrentWorkflow`（工具数 13→14）；agent-web 详情页改名对话框、`WorkflowNodeCard` 动态行静态化为「正在思考」/token 文案「{} tokens」/tint 改 `bg-card`/补 React Flow Handle 修复连线、`NodeDetailDrawer` PR 区块前置、`graph-layout.pickFocusWindow` + `fitView` 窗口自动定位执行中节点（effect 仅依赖执行中集合防抖动）；含 F1-F19 代码事实核对、D1-D14 裁决、T-RN/T-RNM/T-RNWEB/T-WFI 与 A35/E2E-WFI 测试矩阵）
- [[plan/20261104-fix-github-project-setup-optimization.md]] — Github 项目设置优化实现计划（Phase 0~3：契约 `setupCloudHostGithubProject` 注释增补 + schema 双写；`GITHUB_SETUP_SCRIPT` 目录已存在分支重写——同仓库 remote 归一后精确匹配（https/ssh/凭据 URL/`.git`/尾斜杠）直接复用零改动、空目录 `rmdir` 后克隆、异仓库/非空目录/同名文件/`.git` 残骸/`.git` 文件形态统一提示「目标目录已存在其他项目，请修改前缀地址」、符号链接保守非零退出；T-CHG8 断言重写 + 新增 T-GHS1~14 真跑 bash 行为矩阵（gh 桩 + 隔离 PATH，不触网）；agent-api 全量回归、tests/api 零回归、`servers/agent-api/AGENTS.md` 与索引收口；含 F1-F10 代码事实、D1-D6 差异与 9 条计划期裁决）
- [[plan/20261103-feat-workflow-node-interrupt-retry.md]] — 工作流节点中断处理迭代实现计划（Phase 0~9：契约 `RETRY_FAILED`/`retryCount`/`nextRetryAt`；模型 5 个重试字段与迁移 021（fallbackSent→retryCount + 缺失补 0 + 部分索引）；引擎 `retryExhausted` 与重试字段复位；`onSessionStatus` 通用回调 + `session-idle-waiter`（ended.error 判别 + 15s DB 兜底）；新增 `interrupt-retry.ts`（排期 CAS + close→resume→awaitIdle→addMessage 管线）与 30s `interrupt-retry-scheduler`；check-run `action_required` 与 MCP 文案；前端状态/进度/重启入口；T-ENG/T-RETRY/T-IDLE/T-SES/T-SCH/T-MIG/T-FE/API/E2E 矩阵与 A23/A34/E2E-4 回归改写）
- [[plan/20261104-feat-session-management-optimization.md]] — 会话管理优化实现计划（契约先行三件套 agent-session/home/controller-workspace 与手写 schema 双写；Session 新增 archivedAt/controllerWorkspaceId 与迁移 022 索引、create/import 3 处落库；sessionService 归档 setArchived/findAllByUser(archived)/mapSession、统一只读判定三场景（控制器缺失/工作区缺失精确+cwd 回退/云电脑终态）接入 resume/sendSessionMessage/cancelGeneration 且 resume 收敛去重、archiveByWorkspace 删除工作区连带「先结束后归档」幂等且失败中止删除；resolver 透出 archiveSession/sessions(archived)/workspaceArchiveImpact/Session.archived/readOnlyReason（登记 Session spread）/homeOverview.archivedSessions（degrade 兜底）；agent-web 归档按钮与 ArchivedSessionGroup、readOnlyReason 统一只读收敛三态文案、工作区删除确认含连带数量；T-MIG22/T-ARCH/T-RO/T-WSARC/API/E2E 测试矩阵与 D1-D12 裁决）
- [[plan/20261104-feat-cloud-storage-archive-optimization.md]] — 云存储归档优化实现计划（Phase 0~4：契约 `stopCloudHost.archiveStorage` + `CloudHostStopImpact.storage`、`CloudStorageStatus.RESTORING` + 三 mutation + `currentRestore`/`forkedFromStorageId`、附录 A `destroy.storageArchive` 与存储级 archive/restore/operations/restores 回调；cloud-controller `storageArchiveSkipped` 与 `destroying` 同一次 CAS + `cloudstorageoperations` 台账（迁移 003，部分唯一索引）+ restore Job（archiver `MODE=restore`）+ 巡检收口；agent-api `detachToIdle`（`archiveSkipped` 判定在 `!readyAt` 之后）+ 状态机 RESTORING/`archive`/`restoreToArchive`/`fork` + `handleRestoreCallback` + 迁移 022；agent-web 停止对话框勾选（挂载存储不自动停止）与三操作入口；含 F1-F12 代码事实核对、D1-D16 裁决、T-SKIP/T-AR/T-RS/T-FORK/T-OP/T-WEB/API-CSO/E2E-CSO 矩阵与发布回滚顺序）
- [[plan/20261104-feat-tool-call-terminal-rendering.md]] — 会话窗口中工具调用展示优化实现计划（纯前端 apps/agent-web 零契约变更：Phase 0 `@xterm/headless@6.0.0` 精确锁版本 + `lib/terminal-theme.ts` 深黑调色板（16 色/256 色/真彩色 + 加粗亮色 + inverse）；Phase 1 `lib/terminal-buffer.ts` 异步解析（`write` 回调 Promise、`convertEol`、80×24、scrollback 5000、2MB/2000 行上限、样式合并、`stripTerminalSequences` 兜底）；Phase 2 `TerminalOutput` 重写为 React 文本节点 + 60ms 防抖/取消竞态 + 深黑容器（移除 `dangerouslySetInnerHTML`）；Phase 3 删除 `lib/ansi.ts` 与 `ansi-to-html` 依赖；Phase 4 改写 E2E-CREN4 + 新增 E2E-CREN10；含 F1-F12 代码事实核对、D1-D12 裁决与 T-TB/T-TT/T-TO 测试矩阵）
- [[plan/20261104-feat-mcp-valut-iteration.md]] — MCP+Valut 功能迭代实现计划（契约先行：新增 `contracts/valut.graphql`/`contracts/custom-mcp.graphql` + `agent-session.graphql` 增补 `customMcpServerIds` + `agent-session-websocket.md` §2.12 增补 custom 路由口径；Phase 1 agent-api Valut 底座——valutnamespaces/valutentries/valutrefs 三模型 + 迁移 023 播种 manual + valut-service + GraphQL；Phase 2 自定义 MCP——custommcpservers + bearer 新建/引用/删除级联/编辑穿透；Phase 3 会话签发与代理转发——mcp-endpoint +customMcpServers 快照（custom-only 可签发/重签）+ mcp-dispatch custom 分流 + custom-mcp-forwarder 直连真实 endpoint（删除即 410 全端点失效）+ controller-api 镜像模型；Phase 4 agent-web 两区块（「工作区」badge）+ 移除 MCP 代理入口三处 + NewSessionDialog 第 10 参三调用点；Phase 5 测试收口；含 F1-F15 代码事实核对、D1-D14 裁决、T-MIG23/T-VAL/T-CMCP/T-CF/T-WEB/API/E2E 矩阵与发布回滚顺序）
- [[plan/20261104-fix-question-tool-multi-select.md]] — question 工具多选题呈现修复实现计划（纯前端：Phase 0 契约 §2.32 值形态注记 + §2.31 交叉引用、`types.ts` 补 `items.anyOf`；Phase 1 先红 T-QM1~T-QM6 + E2E-QM1 真实 question schema；Phase 2 `ElicitationDialog` array 分支识别 `items.anyOf` 渲染勾选组（含选项说明 + `role="group"`）、`joinMultiSelectValues` 仅对 anyOf 非空数组 `map(optionLabel).join(',')`、enum/oneOf 保持数组；Phase 3 单测/build/lint/E2E 回归与 `apps/agent-web/AGENTS.md` 口径；含 F1-F12 代码事实、D1-D6 差异、10 条计划期裁决与 R1-R6 风险）
- [[plan/20261105-feat-docker-registry-mirrors.md]] — 「Docker」工作负载取消镜像引用规范化 shim 改用 registry-mirrors 实现计划（admin-api migration 021 + 脚本 V6：删除 shim 装配、清理历史 `/usr/local/bin/docker`、写 `/etc/docker/daemon.json` registry-mirrors、配置变更重启 dockerd、`docker info` 镜像地址硬校验；新增 `docker_registry_mirrors` 参数默认 `https://core.harbor.internal.fffdan.com/docker-hub-proxy`、`DOCKER_REGISTRY_MIRRORS` env 最高优先级且可显式清空；地址为空=不配置加速合法语义、环境自管 daemon.json 备份告警；迁移 020 与脚本 V5 已被占用，本计划校正为 021/V6；T-MIG-RM1~RM12 切片测试、tests/api 预制断言与 BUILD.md 验收口径；含 F1-F15 代码事实、D1-D8 差异、16 条计划期裁决）
- [[plan/20261105-feat-session-interaction-content-preview.md]] — 新版会话交互与内容预览实现计划（Phase 0~9：契约先行 agent-session/home/websocket/openapi 四处双写；agent-gear 2.17.0 fs-handler.readFile 白名单 + bridge 有序 parts + mcp 按名超时表；controller-api fs-read-file-service relay（Redis TTL 60s）+ parts 透传 + 按名超时；agent-api sessionreviews 领域 + 迁移 023 + 平台 MCP `agent-session-preview-tools` 全会话装配（排除口径 `$ne→$nin`）+ sessionFileContent 双保险 + addMessage parts 过滤/合并/metadata；agent-web lib/preview 纯函数层（selector/sourcepos/annotations/prompt-parts）+ 手写 store 按 sessionId 工厂（裁决不引入 zustand）+ Monaco@0.57.0 锁版本 seam 懒加载三内容组件 + 分屏三模式宽度门控 + 实况跟随复用 mergeToolCallMessages + ReviewPanel/侧边栏 Review 分区 + InputBox 片段化与 metadata.parts 历史渲染；`express.json` 20mb 与服务端 parts 12MB 上限；tests/api × 2 + tests/e2e session-preview.spec.ts 收口；含 F1-F22 代码事实、D1-D8 差异、18 条计划期裁决）
- [[plan/20261107-feat-workflow-template-project-persistence.md]] — 工作流模板项目持久化实现计划（Phase 0~9：契约先行 agent-session-websocket §3.27/§3.28 + workflow.graphql（RepoWorkflowTemplate/repoWorkflowTemplates/configureRepoWorkflow/ConfiguredWorkflow 来源字段）+ cloud-host.graphql 注释；agent-gear 2.18.0 workflow-templates 扫描模块与事件注册；controller-api 白名单中继 + Redis 结果键 EX 60；agent-api repo-templates 扫描编排与解析校验、configureFromRepo/deleteRepoScopedByController、ConfiguredWorkflow 扩展 sourceKind=REPO 存量零迁移、compareVersions 抽取 version.ts、deleteCloudHost 级联；agent-web 云电脑「工作流」区块 + 检测提示弹窗 + 配置弹窗复用节点编辑器 + 双触发接线；含 F1-F20 代码事实、D1-D4 差异（扫描查询补 nodes 透出等）、16 条计划期裁决与 T-WT/T-WTS/T-RT/T-SCAN/T-CFR/T-DEL/T-RW-WEB/T-REPO-API/E2E-RW 测试矩阵）
- [[plan/20261107-fix-sidebar-badge-active-count.md]] — 侧边栏数字 Badge 优化实现计划（纯前端单行改动：`Sidebar.tsx` 工作流分区 count 由活动+已归档总量改为仅活动数量；TDD 先红后绿新增 T-BDG1/T-BDG2 badge 口径组件用例（容器+标题按钮双层 within 定位）、零契约零后端、E2E 不新增用例以 sidebar-phase4 全量作零回归证据；含 F1-F9 代码事实与 6 条计划期裁决）
- [[plan/20261112-feat-session-interaction-cards.md]] — 会话中的提问表单与权限审批作为会话内容出现实现计划（契约先行三处：agent-session 新增 SessionInteraction 族与 sessionInteractions 查询、workflow 新增 pendingInteractionSessionIds、websocket 新增 permission:resolved 与 60s 口径注记；agent-api sessioninteractions 新集合（模型 + 迁移 025 + SessionInteractionService 唯一读写口：interactionId 幂等、CAS 单调收敛、history 迁移记录）+ subscriber ×2 改造 + respond* 权威切换（CAS 先行于 publish）+ 删除/导入连带；controller-api 补建 permission-manager clearForSocket 并发布 permission:resolved；agent-web 共享表单提取 + InteractionCard 时间线合并 + 倒计时 + 弹窗降级通知跳转 + 工作流列表/图形感叹号；T-SI/T-PM/T-SUB/T-SIR/T-IC/T-TL/T-WFP/API-SI/E2E-SI 测试矩阵；含 F1-F18 代码事实、D1-D6 差异、14 条计划期裁决与 R1-R7 风险）
- [[plan/20261113-feat-cloud-controller-operations-restriction.md]] — 设置中控制器的操作按钮优化实现计划（Phase 0~5：契约先行补齐 regenerateControllerKey 与同文件漂移 unbound/rawKey + 云控制器拒绝说明与错误文案表；agent-api 服务层 rename/unbind/regenerate 三处 cloud 拒绝且零副作用（文案常量单一来源）、resolver 白名单逐字透传；agent-web ControllerListSection 按 type=cloud 收敛按钮仅留「配置」；T-CCOP1~6 / T-CCOP-API1~3 / T-CCOP-WEB1~2 / E2E-CCOP1 测试矩阵；含 F1-F11 代码事实、D1-D3 差异、10 条计划期裁决与 R1-R7 风险）
- [[plan/20261113-feat-cloud-agent-gear-auto-upgrade.md]] — 云环境 agent-gear 自动升级实现计划（纯 worker 镜像 entrypoint 改动、契约零变更：auto_update_loop 周期自升级——pnpm view 检查、mkdir 互斥安装、agent.pid 标记 + SIGTERM 复用保活非 42 路径优雅重启、latest 回滚自动愈合；TDD 红绿——stub 扩展 + T-EP21~T-EP28（提案 T-EP20~T-EP27 编号顺延，T-EP20 已被云存储自举占用）；含 C1~C6 事实校正、11 条设计裁决与 R 风险表；Phase 5 镜像重建发布、存量容器销毁重建）
- [[plan/20261113-feat-oidc-github-oauth-login.md]] — 支持自定义 OIDC 登录和 GitHub OAuth 登录实现计划（契约先行四件：auth/admin-auth 扩展 + admin-auth-provider/auth-oauth.md 新增；admin-api 迁移 022 authproviders（AES-256-GCM secret 不回显、github 部分唯一单条）+ adminexternallogins 绑定与 internal-auth 内部端点；agent-api 迁移 026 externallogins（tenantId 双注册 21→22）+ provisioning 抽取 + oauth-flow/oidc-client（openid-client v6 + PKCE/nonce）/github-oauth/external-login + routes/auth-oauth 统一回调分流；前后台一次性 ticket GETDEL 兑换登录；agent-web/admin-web 登录入口 + /login/callback + 登录认证配置页 + 账号安全页；AppHost 补注 agent-api CREDENTIAL_ENCRYPTION_KEY 与 PUBLIC_BASE_URL/ADMIN_FRONTEND_URL；fake IdP/fake GitHub API 测试与 E2E；含 F1~F16 事实核对与 17 条裁决）
