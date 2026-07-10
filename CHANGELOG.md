# Changelog

## [1.1.4] - 2026-07-10

### GitHub 帐号绑定

- 实现 GitHub App OAuth 安装绑定流程（account + repository 级别权限）
- 绑定列表展示已绑定的 GitHub 帐号和授权仓库
- 支持绑定多个 GitHub 帐号、单独解绑
- 解绑时自动调用 GitHub API 卸载 App
- 更新绑定按钮一键跳转 GitHub 安装配置页（区分个人/组织账号 URL）
- 处理 GitHub App 更新回调（`setup_action=update` 无 state 参数场景）

### 统一网关

- 网关代理请求超时修复：agent-controller 正确解析 `http-request` JSON 协议并包装 `http-response`
- TCP keepalive + 自动重连机制
- 认证支持 `Authorization: Bearer` header 和 `Cookie` 双模式
- 网关列表 UI 调整：移除 `↗` 图标，复制链接改为图标按钮

### 其他修复

- `handleSetup` 中存储 `accountLogin`/`accountType`，构建正确的安装管理 URL
- `GitHubRepo.id` 空值修复（GraphQL 非空字段）
- 路由测试覆盖 `setup_action=update` 场景

### 文档

- 更新 GitHub 绑定 PRD 和技术方案
- gateway-proxy 契约新增 `cookieAuth` security scheme
- AGENTS.md 新增 Lessons Learned（断言关键副作用、跨服务协议测试）
