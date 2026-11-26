# MCP 提示词（prompts）可见性最小复现

对应问题：Issue [Deliay/z-agent-gear#580](https://github.com/Deliay/z-agent-gear/issues/580)
（「MCP 中无法看到「提示词」」）。

调查报告：`docs/engineering/acceptance/20261126-mcp-prompts-not-visible-bug-investigation-report.md`

## 这个用例证明什么

MCP `prompts` 是**客户端能力**：harness（opencode）会用 `prompts/list` 发现提示词，但只把它们
作为**交互式斜杠命令**（`<server>:<prompt>`）交给 ACP 客户端，**从不注入模型上下文**，也不提供
任何让模型自己读取提示词的工具。因此「实际传递给 Agent 的 MCP 里看不到提示词正文」是协议+harness
的既定行为，而不是平台 MCP 端点漏实现。

补充结论（场景 3）：MCP **resources** 在 opencode 下是模型可读的懒加载通道（模型侧工具
`list_mcp_resources` / `read_mcp_resource`），连接期不会主动 `resources/list`；MCP **没有 skills
原语**，Skill 只能由 harness 从文件系统 / HTTP catalog 发现，不能经 MCP 提供。详见调查报告 §九。

> **定稿口径（人类评审裁决）**：#580 的修复为 **resources-only**——片段唯一由 MCP resources 投递，
> **移除** prompts（`capabilities.prompts` / `prompts/list` / `prompts/get`），**不做** tools 兜底。
> 本用例的场景 1 保留为「harness 基线」（证明 prompts 只到客户端、正文不进模型上下文），
> 场景 3 为 resources 通道基线；修复落地后需补「平台服务不再声明 prompts、resources 可读片段正文」的断言。

## 运行

前置：本机可执行 `opencode`（平台锁定版本 `2.1.1`，见
`servers/admin-api/src/migrations/006-preset-harness-opencode.ts`）。

```bash
# 仓库根目录
node tests/e2e/mcp-prompts/run.mjs

# 指定 opencode 二进制
OPENCODE_BIN=/path/to/opencode node tests/e2e/mcp-prompts/run.mjs
```

脚本零依赖（Node 内置模块），会自动：

1. 起三个 MCP 服务桩（`:7811` 提供 prompts，`:7812` 只有 tools，`:7815` 提供 resources）；
2. 拉起 `opencode acp`，`session/new` 时把服务作为 `http` MCP 传入（带 `Authorization`）；
3. 断言场景 1 的 4 件事，并追加场景 2（无 headers 被静默忽略）与场景 3（resources 懒加载）的观察。

## 期望输出

```text
=== 场景 1：prompts 型 + tools 型 MCP 服务（均带 Authorization 头） ===
agent: {"type":"agent-capabilities","mcpCapabilities":{"http":true,"sse":false},"agentVersion":"2.1.1"}
PASS  harness 对 prompts 型服务调用 prompts/list  — calls=1
PASS  harness 对 tools 型服务不调用 prompts/list（按 initialize 能力门控）  — calls=0
PASS  ACP 侧出现 MCP 提示词斜杠命令 prompts-tools:demo-prompt  — commands=init,review,compact,init,review,prompts-tools:demo-prompt,compact
PASS  提示词正文从未进入 model-visible 的 session/update（模型看不到提示词）  — modelVisibleChars=0

=== 场景 2（补充观察）：ACP http MCP 条目不带 headers ===
PASS  不带 headers 的 http MCP 条目被 harness 静默忽略（无任何入站请求）  — requests=0

=== 场景 3（调研观察）：resources 型 MCP 服务的发现时机 ===
PASS  resources 型服务在连接期被 initialize 并做 tools/list  — methods=initialize,notifications/initialized,,tools/list
PASS  连接期不主动 resources/list（资源由模型侧按需拉取，懒加载）  — methods=initialize,notifications/initialized,,tools/list

=== 结果：7/7 PASS （工作目录 /tmp/zag-mcp-prompts-repro） ===
```

工作目录（`/tmp/zag-mcp-prompts-repro`）下保留 `prompts-server.log` / `tools-server.log` /
`noheaders-server.log` / `resources-server.log`，逐条记录 harness 实际发出的 JSON-RPC 方法，便于对照。

## 备注

- 本用例是**问题现象基线**（断言现状行为），不是修复后的验收用例。修复方案落地后需要新增
  「模型可通过 MCP 工具拿到片段正文」的断言（见调查报告 §七）。
- 场景 2 记录的是 opencode 2.1.1 的一个脆弱点（不带 `headers` 的 http MCP 条目会被静默忽略）；
  平台链路始终下发 `Authorization` 头，因此当前不受影响，但作为回归观察点保留。
