# Product 文档管理

本文档描述了 `docs/product/` 目录下的产品文档管理规范。

## 生命周期

产品文档经历四个阶段，对应四个子目录：

| 阶段 | 目录 | 说明 |
|------|------|------|
| 草稿 | `draft/` | 新建或编辑中的产品文档，等待 Review |
| 已审 | `reviewed/` | 通过 Review，准备开始实现 |
| 实现中 | `shipping/` | 正在开发实现中的产品文档 |
| 已发布 | `released/` | 已成功上线验收的产品文档 |

## 文件命名规范

遵循 [[../../.agents/skills/z-document/SKILL.md|z-document]] 标准：

```
{ID}-{Title-With-Hyphens}.md
```

- **ID**: 使用创建日期作为唯一标识符，格式 `YYYYMMDD`（如 `20260521-`），仅用于排序和去重
- **标题**: ID 之后紧跟，使用连字符分隔

示例：`20260521-acp-session-sync-PRD.md`

## 文档结构

每个产品文档应包含 YAML front matter 及以下内容：

```markdown
---
description: 简短说明此文档的用途
type: Permanent
---

# 需求名称

**功能名称**: ...
**PRD 版本**: v1.0
**创建日期**: YYYY-MM-DD
**作者**: ...

## 背景与目标

### 1.1 背景
### 1.2 目标
### 1.3 成功标准

## 用户分析

### 2.1 目标用户
### 2.2 用户场景

## 功能需求

### 3.1 功能概述
### 3.2 功能列表
### 3.3 用户操作流程
### 3.4 页面/界面描述
### 3.5 异常与边界情况

## 四、非功能需求

## 五、依赖与约束

## 六、相关文档
```

产品文档中禁止提及技术细节，禁止提及项目结构、前端组件、后端 API 设计等内容。必须使用 Mermaid 图形描述流程。

## 工作流程

```mermaid
flowchart LR
    D[draft/] -->|Review 通过| R[reviewed/]
    R -->|开始实现| S[shipping/]
    S -->|上线验收| P[released/]
```

### 创建文档

1. 加载 `z-product` skill
2. 使用 `question` 工具澄清产品细节
3. 创建文件到 `draft/` 目录，以创建日期为 ID
4. 提交流程遵循项目 git 规范

### 修改文档

1. 确认文档所在阶段目录
2. 修改后保持文件名不变
3. 更新 PRD 版本号

### Review 文档

1. 确认内容无技术细节
2. 确认满足文档结构模板要求
3. 确认 YAML front matter 完整
4. 通过后移入 `reviewed/` 目录

## Skill 参考

| Skill | 用途 |
|-------|------|
| [[../../.agents/skills/z-product/SKILL.md\|z-product]] | 产品文档完整生命周期管理 |
| [[../../.agents/skills/z-document/SKILL.md\|z-document]] | 文档格式与命名规范 |

## 相关文档

### 草稿文档（`draft/`）

- [[draft/20260811-agent-workflow-phase2.md]] — Agent 工作流二期
- [[draft/20260817-session-lifecycle-and-worktree-management.md]] — 会话生命周期与 Worktree 管理
- [[draft/20260821-workflow-optimization.md]] — 工作流优化 0821
- [[draft/20260829-workflow-worktree-session-start.md]] — 工作流 Worktree 节点会话启动失败修复
- [[draft/20260907-experience-optimization-phase1.md]] — 综合体验优化一期
- [[draft/20261014-admin-console.md]] — 云控制器管理后台一期
- [[draft/20261014-cloud-agent-phase2.md]] — 云Agent二期（K8s 云端工作容器）
- [[draft/20261017-cloud-controller-workload.md]] — 云控制器工作负载功能
- [[draft/20261018-workload-phase1.md]] — 工作负载一期（参数、依赖与预制工作负载）
- [[draft/20261018-workload-phase3.md]] — 工作负载三期（必须工作负载硬失败与 .NET 安装优化）
- [[draft/20261018-workload-phase4.md]] — 工作负载四期（工作容器基础环境瘦身）
- [[draft/20261018-docker-ce-apt-source.md]] — Docker CE 软件源地址补齐（修复 Docker 工作负载初始化必然失败）
- [[draft/20261019-aspire-workload-proxy.md]] — Aspire 工作负载下载代理（Aspire CLI 内网代理下载）
- [[draft/20261017-controller-version-requirement.md]] — 云端工作容器控制器版本兼容与自动恢复
- [[draft/20261018-credits-billing.md]] — 费用中心（Credits 计费）
- [[draft/20261020-api-channel-model-fixes.md]] — 内建API渠道一期上线后问题修复（供应商与模型管理）
- [[draft/20261021-acp-protocol-enhancement.md]] — ACP 协议增强（能力透明化与模型来源分组）
- [[draft/20261021-github-workload.md]] — Github 工作负载与云主机 Git 项目设置（Github 预制工作负载、拉起后安装与 MCP 开放、云主机申请最小化凭据 clone 并自动建会话）
- [[draft/20261022-workload-optimization.md]] — 工作负载优化（云电脑支持 Aspire/Docker/.NET 负载展示与使用、MCP 列出与安装，Github 项目 clone 地址前缀拼接）
- [[draft/20261023-cloud-container-optimization-phase2.md]] — 云容器优化二期（创建期不预置默认工作区：仅「Git 项目设置」初始化 Github 项目时创建工作区并回写 workspaceId、后台模型设置支持模型最长上下文大小、云电脑模板 ephemeral-storage 上限 10Gi 仅 limits）
- [[draft/20261020-container-harness-support.md]] — 容器启动任务支持 harness 类型（OpenCode 云电脑，v5.0 停止即销毁/会话只读/每用户 1 实例；会话导入导出与统一存储二期）
- [[draft/20261022-cloud-container-optimization-phase1.md]] — 云容器优化一期（会话/工作流「+」列表实时刷新、新建云电脑初始化 Github 项目、新建会话默认注入 MCP 与默认 MCP 设置、拉起会话前置选择模型与模式）
- [[draft/20261023-workflow-github-pr-callback.md]] — 工作流 GitHub Pull Request 联动（工作流关联 GitHub PR 并随完成/归档注销、人类节点「联动上游 Pull Request」由审核结果驱动完成/打回、工作流追加提示词与 PR 工具使用指引）
- [[draft/20261025-opencode-model-context-length.md]] — 云电脑 OpenCode 模型上下文长度下发修复（后台配置的模型最长上下文随模型清单写入云电脑内 OpenCode 配置）
- [[draft/20261025-kimi-code-harness.md]] — 增加工作负载「Kimi Code」（Harness）（与 OpenCode 同级的第二个 harness 工具、使用前登录确认与登录引导弹窗：按 stdio 登录链接授权后自动继续）
- [[draft/20261025-github-issues-workflow.md]] — 云电脑 GitHub Issues 联动工作流（云电脑设置「Github」区块以列表维护多条联动配置：先选含人类节点的已配置工作流、默认标签 start-{工作流名字}可改、多选仓库并同步标签；带标签 Issue 自动完成工作区准备、实例化工作流、回评工作流地址、首个人类节点自动完成；销毁云电脑时经确认清理已同步标签）
- [[draft/20261025-workflow-check-runs-sync.md]] — 工作流节点状态通过 GitHub Check Runs 同步（绑定 PR 的节点状态写入 PR 最新提交检查项、旧提交标记 stale、todo panel 同步为检查项子项）
- [[draft/20261025-deepseek-harness.md]] — 增加工作负载「DeepSeek Harness」（Harness）（与 OpenCode / Kimi Code 同级的第三个 harness 工具、启动时默认注入平台渠道模型：开箱即用无需登录、模型选择仅平台渠道一组）
- [[draft/20261026-issues-workflow-force-worktree.md]] — GitHub Issues 联动工作流强制 Worktree 隔离（联动触发的工作流强制启用独立 Worktree 副本执行、主分支零改动、多 Issue 并发互不干扰；工作区主分支信息缺失时自动识别回填——GitHub 项目经平台授权获取、其他按 main/master/release 顺序探测，完全无法识别才明确失败不降级到主分支）
- [[draft/20261025-cloud-host-keepalive.md]] — 云电脑保活与 worker 用户（控制进程退出即自动拉起、仅「停止云电脑」等明确销毁指令可终止；容器内默认普通用户 worker、可安装 apt 包、无法终止系统级保活进程）
- [[draft/20261026-default-workspace-optimization.md]] — 默认工作区优化（Git 项目设置不建会话时也初始化项目工作区、云电脑配置「Github 项目设置」入口迁移至 Github 页面、前缀地址默认 ~/workspace）
- [[draft/20261027-unlimited-cloud-hosts.md]] — 用户开放无限制云电脑支持（创建收费 5 credits、创建对话框收费详情、放开每用户数量限制、Github 帐号跟随云电脑选定后不可修改）
- [[draft/20261027-commit-author-settings.md]] — 云容器 Commit 提交人设置（设置页 GitHub 绑定下方新增「Commit 设置」：提交人模式「仅Agent/Co-Author/仅人类/未设置」× 提交人「Github帐号/自定义/未设置」，仅对云容器环境生效）
- [[draft/20261027-dsh-header-masq.md]] — DeepSeek Harness 会话标识请求头注入（预置工作负载自动安装 dsh-header-masq 插件并按平台口径配置：模型调用自动携带会话标识请求头，同会话固定、新会话变化、重启续聊不变）
- [[draft/20261027-multi-tenant-phase1.md]] — 多租户一期（三层帐号体系：租户 tenant→用户 user 一对多、账户 account→用户 user 承载登录；每用户同名个人专属租户不可删除/一期单成员；余额迁移租户并按租户口径计费、计费系统兼容后台账户与租户双 owner；数据按租户归属与隔离、租户内仍跟创建者本人（口径与上线前一致）；前台关闭注册改后台开户；后台不做多租户设计、仅租户与账户只读查看）
- [[draft/20261028-conversation-rendering.md]] — 重构对话渲染（参考 zed ACP 数据处理与渲染：代码块工具栏、Mermaid 图形、真实差异渲染、终端 ANSI 颜色、工具调用图标与原始数据查看、消息复制与对话导出、滚动导航、计划展示增强）
- [[draft/20261028-multi-tenant-phase2.md]] — 多租户二期（Team 类型租户：后台创建、成员须为已存在账户；租户角色两级：管理员=管理租户全部资源/全部工作区可见/可建工作区/按帐号名搜索添加成员/变更角色，开发=不可建工作区/读写删除所在普通工作区资源/全局工作区只读，last-admin 保护、personal 唯一成员恒管理员；默认「全局工作区」不可删除/改名/无成员列表，仅管理员可创建普通工作区（0..n 成员）；普通工作区可用全局工作区模型/Github 绑定，Commit 设置三段继承；团队消费计入团队租户）
- [[draft/20261028-mongodb-workload.md]] — 增加工作负载「MongoDB」（原生 apt 经内网源安装 MongoDB 8.0：工作负载目录新增预制标准工作负载、安装成功以 mongod --version 硬校验且不拉起实例、幂等可重复、失败可恢复）
- [[draft/20261028-playwright-workload.md]] — 增加工作负载「Playwright」（新增「Playwright」预制工作负载：安装测试工具与内置浏览器 Chromium/Firefox/WebKit、浏览器下载走内网 playwright-proxy 且下载地址可按次调整、三入口安装与幂等可用保障）
- [[draft/20261029-interrupted-call-token-billing.md]] — 调用中断的 token 计费优化（中断调用输入 token 按 20% 未缓存 + 80% 已缓存计价、输出保持全价，明细保留中断标注并体现输入两段拆分）
- [[draft/20261030-ui-optimization-phase4.md]] — UI 优化四期（侧边栏与工作流视图：侧边栏 VSCode 风格可折叠分区「主机/工作流/会话/网关」与跨环境聚合、拖拽调宽、主机层级缩进与空态收敛、人类节点侧边抽屉；工作流卡片两行化、图表竖向布局画布占满、节点卡片信息增强与主题跟随、黑板/PR/追加提示词资源上图、节点状态整体配色与加粗箭头连线）
- [[draft/20261029-pnpm-workload-and-harness-optional.md]] — 云电脑组件安装切换 pnpm 与工作负载 Harness 可选化（云电脑内组件与工作负载（含 harness）安装统一由 npm 改为 pnpm、环境预装 pnpm；已运行云电脑设置-工作负载显示 harness 为可选工作负载、可后期按需安装；创建时 harness 改为可选可补装）
- [[draft/20261030-unified-logging-and-otel.md]] — 规范化日志与全链路可观测性（全运行时统一结构化日志并取消自由文本打印、跨服务与云电脑 Job 的全链路追踪、请求标识与脱敏、级别/采样/外发开关可控）
- [[draft/20261031-commit-with-bot-coauthor.md]] — Commit 与 bot 共同提交（设置页「Git」区块新增「与 bot 共同提交」勾选项：仅提交人为自定义时可用，勾选后 Worktree 提交以成员为主作者、平台 bot 为共同作者；云电脑自身提交仍为 bot 单独署名，旧版本云电脑与 bot 不可用时优雅降级）
- [[draft/20261102-cloud-storage.md]] — 云电脑支持申请存储（设置-云存储按 1~30Gi 创建并阶梯小时计费、归属工作区并记录创建人；整块存储挂载为云电脑主目录且初始化工作负载前完成挂载、工作负载支持重复安装；状态机 待挂载/已挂载/归档中/已归档/已销毁（含创建失败），销毁云电脑时自动压缩为 .tar.gz2 原子替换写入工作区 100Gi 归档空间，已归档半价，已销毁折叠展示）
- [[draft/20261102-controller-session-takeover.md]] — 云控制器重复登录改为新连接接管（同一 Key 再次登录不再拒绝新连接，改为接受新连接并踢出旧连接；重点修复 controller-api 重启后云容器内客户端自动重连被提示「已在线」的问题，旧连接被替换后不重连、不清 Key、不影响绑定与云电脑生命周期）
- [[draft/20261103-workflow-iteration.md]] — 工作流迭代（工作流实例改名含 Agent 内置工具改名、节点卡片只显示「正在思考」指示、修复依赖连线不可见、详情 PR 优先于黑板产物、token 文案改「{} tokens」、卡片不透明、图表视图自动居中执行中卡片且容纳前后各 2 个卡片）
- [[draft/20261103-workflow-node-interrupt-retry.md]] — 工作流节点中断处理迭代（AI 节点会话中断自动重试由最多 1 次提升为最多 10 次：首次立即、之后指数退避、单次间隔封顶 30 分钟；重试动作改为「关闭会话→继续会话→等待空闲→重发提示词」；重试用尽转入新状态「重试失败」，不再自动重试、待人工重启或指示后恢复）
- [[draft/20261104-session-management-optimization.md]] — 会话管理优化（会话支持归档：归档入口对齐工作流放在会话页右上角按钮组、已归档会话移入侧边栏「已归档」分组；删除/清空工作区时其下普通会话先结束后归档而非连带消失；工作区/控制器/云电脑缺失的会话统一只读回看、不允许继续）
- [[draft/20261105-docker-registry-mirrors.md]] — 「Docker」工作负载取消镜像引用规范化脚本，改用 Docker 原生镜像仓库镜像配置（去掉自定义镜像地址改写逻辑，镜像拉取加速由 Docker 自身的镜像仓库镜像能力承担，地址默认填入内部代理且启动时可见可调；历史改写组件自动清理，存量未定制环境一次性升级）
- [[draft/20261104-cloud-storage-archive-optimization.md]] — 云存储归档优化（停止云电脑时归档可选：不勾选则存储回「待挂载」继续全价计费、数据原样保留；云存储新增「归档」（待挂载→已归档，与停止勾选归档同逻辑）、「复原到归档」（丢弃当前内容从归档重建，创建人/管理员）、「fork」（从归档复制新存储，规格不可调整）；新增瞬态「复原中」）
- [[draft/20261104-tool-call-terminal-rendering.md]] — 会话窗口中工具调用展示优化（终端输出按真实终端效果正确渲染：颜色/样式正确呈现、进度条与覆写等动态输出收敛为最终画面、无控制字符乱码；终端渲染区域采用深黑色主题配色）
- [[draft/20261104-github-project-setup-optimization.md]] — Github 项目设置优化（目标目录已存在时的处理策略：同一仓库直接复用不改动内容、空目录自动清理后继续克隆、其他占用明确提示「目标目录已存在其他项目」且内容不被改动）
- [[draft/20261104-mcp-valut-iteration.md]] — MCP+Valut 功能迭代（Valut 工作区级加密密钥存储：namespace 聚合、值加密不回显、「工作区」权限、refs 引用展示、对外仅可选 manual；MCP 迭代：前端移除「MCP 代理」入口、新增工作区级自定义 HTTP MCP 支持无验证/Bearer 且 token 落 Valut、删除编辑联动；自定义 MCP 经平台代理转发、访问密钥随会话生灭、删除即全端点失效）
- [[draft/20261104-question-tool-multi-select.md]] — question 工具多选题呈现修复（ACP 问询多选题由文本输入框改为勾选组呈现，可多选作答，所选答案按逗号拼接回传 Agent；单选等其他题型零回归）
- [[draft/20261105-session-interaction-content-preview.md]] — 新版会话交互与内容预览（内容组件：代码组件行定位/差异/批注模式 + HTML/Markdown 预览与批注回传；会话代码分屏三模式与宽度门控、实况跟随工具调用读写（写=常开 Tab 差异聚焦、读=共享预览 Tab）；会话内建 Review 工具：逐文件批注 + 通过/驳回/仅评论结构化回传、Review 侧边栏待办；输入框重构为附件式提示词片段（本期文本/图片））
- [[draft/20261107-workflow-template-project-persistence.md]] — 工作流模板项目持久化（工作流模板放置在仓库 .zag/workflow/templates/、一个 JSON 文件一个模板；新增工作目录/设置 GitHub 项目后自动检测并提示配置；云电脑设置中可随时查看与配置；项目来源已配置工作流生命周期跟随云电脑、销毁时一并销毁）
- [[draft/20261112-session-interaction-cards.md]] — 会话中的提问表单与权限审批作为会话内容出现（Elicitation/权限审批持久化为会话时间线卡片：完整状态迁移与提交内容回显、过期倒计时；弹窗降级为通知与跳转会话链接；工作流列表/图形视图节点待审批感叹号点击展开会话）
- [[draft/20261113-cloud-controller-operations-restriction.md]] — 设置中控制器的操作按钮优化（云电脑/云控制器在「设置-控制器管理」不展示「重命名/删除/重新生成Key」三个操作入口，服务端同步拒绝三操作且零副作用；本地控制器零变化）

### 实现中文档（`shipping/`）

- [[shipping/20261025-cloud-container-unlimited-lifetime.md]] — 云电脑取消最长运行时间限制（云端工作容器不再因到达时间上限被平台强制销毁）
- [[shipping/20261029-commit-author-settings-optimization.md]] — Commit 作者设置优化（提交人由团队共享改为成员独立并迁入新增「Git」区块、提交人模式下线；「自定义」增加「导入Github帐号信息」弹窗并移除「Github帐号」类型（存量自动转换）；提交身份按上下文下发：云电脑自身=平台 bot、勾选 Worktree 的会话/工作流=创建者、Issue 拉起的工作流=触发人）
- [[shipping/20261113-oidc-github-oauth-login.md]] — 支持自定义 OIDC 登录和 GitHub OAuth 登录（后台统一配置全局 OIDC Provider（可多条）与 GitHub OAuth（单条），按前台/后台分别启用；前后台登录页展示跳转登录按钮，前台首次登录自动开户，后台管理员先绑定后登录）
- [[shipping/20261113-cloud-agent-gear-auto-upgrade.md]] — 云环境 agent-gear 自动升级（云端工作容器运行期间每 10 分钟检查更新，发现新版即安装最新 agent-gear 并重启服务，失败收敛可观测，无需销毁重建）

### 已发布文档（`released/`）

- [[released/20260517-agent-controller-v1.md]] — Agent 控制器管理 v1
- [[released/20260517-llm-provider-settings.md]] — LLM 供应商与模型管理
- [[released/20260517-user-auth-and-settings.md]] — 用户认证与设置页
- [[released/20260518-agent-session-interaction.md]] — Agent 拉起与交互
- [[released/20260519-local-controller-workspace-management.md]] — 本地控制器工作区管理
- [[released/20260520-session-reopen-prd.md]] — Session Re-open
- [[released/20260521-acp-session-sync-history.md]] — 工作目录历史会话同步
- [[released/20260522-available-models-and-mode-switch.md]] — 可用模型与模式切换
- [[released/20260522-local-controller-config-page.md]] — 本地控制器配置页
- [[released/20260522-model-switch-support.md]] — 模型切换支持
- [[released/20260523-git-worktree-support-prd.md]] — Git Worktree 支持
- [[released/20260523-workspace-git-support-prd.md]] — 工作区 Git 支持
- [[released/20260524-session-message-history-optimization.md]] — 会话消息历史优化
- [[released/20260526-multi-acp-server-support.md]] — 多 ACP Server 支持
- [[released/20260526-ui-optimization.md]] — UI 优化一期
- [[released/20260526-ui-optimization-phase2.md]] — UI 优化二期
- [[released/20260527-mobile-layout.md]] — 移动端布局
- [[released/20260527-port-forwarding-for-local-agent-controller.md]] — 本地 Agent 控制器端口转发
- [[released/20260527-unified-agent-status.md]] — 统一 Agent 状态
- [[released/20260528-acp-permission-reminder.md]] — ACP 授权提醒
- [[released/20260528-frontend-ui-optimization.md]] — 前端界面优化三期
- [[released/20260529-command-mode.md]] — 命令模式
- [[released/20260529-dark-mode.md]] — 黑暗模式
- [[released/20260530-mcp-proxy-config.md]] — MCP 代理服务配置
- [[released/20260705-acp-server-extend.md]] — ACP Server 支持扩展
- [[released/20260707-unified-gateway.md]] — 统一网关功能
- [[released/20260709-github-account-binding.md]] — GitHub 帐号绑定
- [[released/20260721-acp-server-mimo-kimi.md]] — ACP Server 支持 MiMo Code / Kimi Code CLI
- [[released/20260721-frontend-design-overhaul.md]] — 整体前端设计优化
- [[released/20260723-session-scroll-loading.md]] — Session 对话滚动加载
- [[released/20260803-acp-v1-completion.md]] — ACP v1 协议补全与展示优化
- [[released/20260804-chat-interaction-optimization.md]] — 对话交互优化
- [[released/20260804-integrated-mcp-registry.md]] — 集成式 MCP 注册中心
- [[released/20260808-agent-workflow.md]] — Agent 工作流
