# Changelog

## [Unreleased]

### 修复

- 修复新建会话/工作流拉起会话时设置的「模式与模型」偶现失效：agent-controller 应用初始 mode/model 后
  经 ACP 协议回读确认（config-option 响应快照比对），失败重试一次；`session/new` 未携带 configOptions 时
  挂起等待 `config_option_update` 补应用（上限 `INITIAL_CONFIG_PENDING_TIMEOUT_MS`，默认 10s），不再静默回退默认值
- 新增 `acp:initial-config:result` 事件（Controller → Server）：确认收敛后恰好上报一次，
  controller-api 校验落库 `initialConfigError` 并经 `session:status` 透传至前端，失败时前端 toast 提示实际生效值
- 修复 initialized payload 先于应用构造导致落库默认值的问题（payload 现携带确认后的生效值）

## [1.1.4] - 2026-07-10

### ACP Server 扩展

- 新增 Claude Code、Gemini CLI、Codex 三种 ACP Server 支持
- 历史会话导入支持按 ACP Server 类型筛选
- 前端创建 Session 时可选 Server 类型

### GitHub 帐号绑定

- 支持通过 GitHub App 绑定 GitHub 帐号，管理授权仓库
- 支持绑定多个 GitHub 帐号，可单独解绑
- 解绑时自动从 GitHub 卸载 App
- 绑定后可一键跳转 GitHub 配置页管理仓库权限

### 统一网关

- 修复网关代理超时问题，提升稳定性
- 改进网关认证，支持浏览器 Cookie 方式访问
- 网关列表 UI 优化，复制链接改为图标按钮

### 文档整理

- 产品文档与技术文档分类归档
- AGENTS.md 补充开发经验总结
