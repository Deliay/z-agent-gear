# Changelog

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
