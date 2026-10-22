---
description: OpenCode ACP 支持清单调研：OpenCode（v1/v2）作为 ACP Agent 的方法覆盖、agentCapabilities 取值、session/update 类型、客户端方法调用、_meta 扩展与不支持项，附源码与实测证据
type: Permanent
---

# OpenCode ACP 支持清单（调研报告）

**调研日期**: 2026-10-21
**调研对象**: OpenCode（https://opencode.ai ，GitHub: https://github.com/anomalyco/opencode ，历史仓库 sst/opencode）
**协议基准**: Agent Client Protocol（ACP）v1（https://agentclientprotocol.com/protocol/v1/ ），`protocolVersion: 1`
**用途**: ACP 协议增强（能力透明化 / 能力驱动适配 / 扩展兼容降级）产品与技术方案输入

---

## 0. 结论速览

1. OpenCode 通过 `opencode acp` 子命令以 **NDJSON JSON-RPC over stdio** 作为 **ACP Agent** 被编辑器/平台托管；协议主版本为 `protocolVersion: 1`（来源：[v2 文档 · ACP](https://opencode.ai/v2/docs/cli/acp)、`packages/cli/src/commands/commands.ts:89`）。
2. OpenCode 存在两代 ACP 实现，能力差异显著：
   - **v2（当前主线，实测 `opencode v2.0.31`，源码 dev 分支 package 版本 2.1.1）**：完整实现 14 个 Agent 方法（含 `session/list|delete|resume|close|fork|set_config_option`）、compaction/usage/elicitation/子会话扩展，是本次调研主对象。
   - **v1（tag `v1.17.9`，`packages/opencode/src/acp/`，SDK `@agentclientprotocol/sdk@0.21.0`）**：方法集更小（无 `session/delete`）、能力声明更弱（无 `additionalDirectories`/`delete`、无 `_meta`），且会调用客户端 `fs/write_text_file`。
3. OpenCode **完全自己处理文件与终端**：v2 不调用客户端 `fs/*`、`terminal/*`（v1 仅在 edit 权限确认后调用 `fs/write_text_file` 写回）。工具执行发生在 Agent 进程侧。
4. 扩展机制使用充分：`_meta` 自定义键 5 个 + 自定义通知方法 1 个（`opencode/session/child_update`）+ 会话 metadata 键 1 个，均集中在子会话、重试状态、压缩标记、终端认证四类场景（来源：`packages/cli/src/acp/{capabilities,child,translate,compaction,directories}.ts`、[v2 文档 · ACP Protocol reference](https://opencode.ai/v2/docs/cli/acp)）。
5. 明确不支持：`logout`、`providers/*`、`nes/*`、`document/*`、`mcp/message`（MCP over ACP）、`plan/plan_update/plan_removed`、`notice`、`current_mode_update`、`subagent_update`、`session_message*`、audio 提示块、内置 slash 命令 `/undo`、`/redo`（以普通文本透传）。

---

## 1. 调研方法与证据来源

| 证据类型 | 内容 | 位置/链接 |
| --- | --- | --- |
| 官方文档 | ACP 支持页（v1 文档体系） | https://opencode.ai/docs/acp/ |
| 官方文档 | ACP 协议参考（v2 文档体系，最权威的能力清单） | https://opencode.ai/v2/docs/cli/acp |
| 官方文档 | MCP servers（v1 / v2） | https://opencode.ai/docs/mcp-servers/ 、https://opencode.ai/v2/docs/mcp-servers |
| 官方文档 | Permissions / Tools / Commands（v1 / v2） | https://opencode.ai/docs/permissions/ 、https://opencode.ai/docs/tools/ 、https://opencode.ai/docs/commands/ 、https://opencode.ai/v2/docs/tools 、https://opencode.ai/v2/docs/commands |
| 一手源码（v2） | ACP 适配层（dev 分支 tarball，package 版本 2.1.1） | `packages/cli/src/acp/*.ts`（agent/service/turn/translate/connection/capabilities/catalog/config-option/permission/elicitation/child/compaction/prompt/replay/tool/content/directories/error/sessions） |
| 一手源码（v2 测试） | ACP 行为测试 | `packages/cli/test/acp/*.test.ts` |
| 一手源码（v1） | ACP 适配层（tag v1.17.9 tarball） | `packages/opencode/src/acp/*.ts`、`packages/opencode/src/cli/cmd/acp.ts` |
| 协议基准 | ACP v1 规范全文（含 RFD 索引） | https://agentclientprotocol.com/protocol/v1/ （overview / initialization / session-setup / prompt-turn / tool-calls / session-modes / slash-commands / session-list / session-delete / session-config-options / file-system / terminals / elicitation / extensibility） |
| 协议实现 | OpenCode 使用的官方 SDK `@agentclientprotocol/sdk@1.6.0`（v2）/ `0.21.0`（v1） | npm 包 `dist/schema/index.d.ts`（AGENT_METHODS / CLIENT_METHODS 全集） |
| **行为实测** | 对本机安装的 `opencode v2.0.31` 运行 `opencode acp`，用探针脚本走完 `initialize → session/new → session/prompt → session/list` 全流程 | 探针脚本 `/tmp/opencode/acp-probe.mjs`、`/tmp/opencode/acp-turn-probe.mjs`，抓包 `/tmp/opencode/probe-out.json`、`/tmp/opencode/turn-out.json` |

> 说明：v2 源码为 `dev` 分支（2026-10-21 拉取，`package.json` version `2.1.1`），实测二进制为 `v2.0.31`，两者 `initialize` 响应逐字段一致，故下文以源码为能力上界、以实测为行为确认。v1 结论标注为「v1」，未实测（未安装 v1 二进制）。

---

## 2. OpenCode 的 ACP 接入形态

| 项 | 结论 | 来源 |
| --- | --- | --- |
| 命令入口 | `opencode acp`（v2 另有 `--login` flag，用于终端认证流） | [v2 docs](https://opencode.ai/v2/docs/cli/acp)、实测 `opencode acp --help` |
| 角色 | ACP **Agent**（被 Zed/JetBrains 等 Client 托管的子进程） | [v1 docs](https://opencode.ai/docs/acp/) |
| 传输 | stdin/stdout 上的换行分隔 JSON-RPC（NDJSON），不开放网络端口 | [v2 docs](https://opencode.ai/v2/docs/cli/acp#transport)、`packages/cli/src/acp/connection.ts`（`ndJsonStream`） |
| 进程模型 | `opencode acp` 会启动一个**私有 OpenCode server**（不连共享后台服务）；一个进程可服务多个 ACP session；stdin 关闭即退出 | [v2 docs](https://opencode.ai/v2/docs/cli/acp#transport) |
| 协议取消 | 支持 `$/cancel_request`（等效 `session/cancel`） | [v2 docs](https://opencode.ai/v2/docs/cli/acp#cancellation)、`packages/cli/src/acp/turn.ts`（`aborted(signal)`） |
| 调试 | `opencode --print-logs acp` 将 ACP 与私有 server 日志写 stderr，stdout 只走协议 | [v2 docs](https://opencode.ai/v2/docs/cli/acp#troubleshooting) |

---

## 3. Agent 侧方法支持清单

OpenCode v2 注册的请求/通知处理程序（证据：`packages/cli/src/acp/agent.ts:68-118`）；方法全集对照 `@agentclientprotocol/sdk@1.6.0` 的 `AGENT_METHODS`（`dist/schema/index.d.ts`）。

| ACP 方法 | 类型 | v2 支持 | v1 支持 | 差异/说明 | 证据 |
| --- | --- | --- | --- | --- | --- |
| `initialize` | 请求 | ✅ | ✅ | 返回 `protocolVersion: 1` 与 agentCapabilities（见 §4） | `service.ts:107-130`；v1 `service.ts:89-129` |
| `authenticate` | 请求 | ✅ | ✅ | 仅接受 `opencode-login`，**不收集凭据**（no-op 返回 `{}`），未知 methodId 报 invalid params | `service.ts:131-136`；[v2 docs](https://opencode.ai/v2/docs/cli/acp#authentication) |
| `logout` | 请求 | ❌ | ❌ | 未注册处理程序（协议要求 `agentCapabilities.auth.logout` 才生效，OpenCode 也未声明） | `agent.ts` 无 `logout`；实测未知方法返回 `-32601` |
| `providers/list` / `providers/set` / `providers/disable` | 请求 | ❌ | ❌ | 未注册、未声明 `agentCapabilities.providers` | 同上 |
| `session/new` | 请求 | ✅ | ✅ | 校验 `cwd` 绝对路径、`additionalDirectories`、`mcpServers`；返回 `sessionId` + `configOptions` | `service.ts:137-151` |
| `session/load` | 请求 | ✅ | ✅ | 声明 `loadSession: true`；**回放历史消息**（`session/update` 重放），返回 `configOptions` | `service.ts:152-168`、`replay.ts` |
| `session/list` | 请求 | ✅ | ✅ | 分页（每页 ≤100）、支持 `cwd` 过滤与 `cursor`；返回 `sessionId/cwd/title/updatedAt/additionalDirectories/nextCursor` | `service.ts:169-193` |
| `session/delete` | 请求 | ✅ | ❌ | v2 先取消进行中的 prompt 再删除；删除不存在的会话**成功返回**（幂等） | `service.ts:194-205`；v1 `agent.ts` 无该方法 |
| `session/resume` | 请求 | ✅ | ✅ | 附加（attach）会话但**不回放历史** | `service.ts:206-213` |
| `session/close` | 请求 | ✅ | ✅ | 中断活动工作并分离会话，保留已保存会话 | `service.ts:214-218`、`turn.ts:close` |
| `session/fork` | 请求 | ✅ | ✅（unstable） | v2 正式注册；v1 为 `unstable_forkSession`。fork 继承源会话授权，随后被本次请求的 `additionalDirectories` 覆盖 | `service.ts:219-229`；v1 `agent.ts:63` |
| `session/set_config_option` | 请求 | ✅ | ✅ | **仅接受字符串值**；支持 `model` / `effort` / `mode` 三个 configId；非法值报 invalid params | `service.ts:230-236`、`config-option.ts:resolveChange` |
| `session/set_mode` | 请求 | ✅ | ✅ | 等效把 `mode` 设为指定 agent（主模式） | `service.ts:237-240` |
| `session/prompt` | 请求 | ✅ | ✅ | 单会话同一时刻只跑一个 prompt，重复调用报错；`$/cancel_request` 与 `session/cancel` 等效 | `turn.ts:prompt`；[v2 docs](https://opencode.ai/v2/docs/cli/acp#sessions) |
| `session/cancel` | 通知 | ✅ | ✅ | 结束活动 prompt，`stopReason: "cancelled"`；拒绝挂起的权限请求；未完成工具标 `failed` | `turn.ts:cancel`、`translate.ts:abandon` |
| `session/set_model`（unstable） | 请求 | ❌ | ✅ | v1 提供 `unstable_setSessionModel`；v2 改为 `session/set_config_option(configId: "model")` | v1 `agent.ts:75`；v2 `config-option.ts` |
| `mcp/message` | 请求 | ❌ | ❌ | 不支持 MCP over ACP | [v2 docs](https://opencode.ai/v2/docs/cli/acp#mcp-servers) |
| `nes/*`（5 个） | 请求 | ❌ | ❌ | 未注册、未声明 `agentCapabilities.nes` | `agent.ts` |
| `document/did*`（5 个） | 通知 | ❌ | ❌ | 未注册 | `agent.ts` |

---

## 4. `initialize` 返回的 agentCapabilities（实测原文）

实测 `opencode v2.0.31`（2026-10-21）`initialize` 响应（`/tmp/opencode/probe-out.json`，与 `packages/cli/src/acp/service.ts:110-130` 一致）：

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "loadSession": true,
    "mcpCapabilities": { "http": true, "sse": false },
    "promptCapabilities": { "embeddedContext": true, "image": true },
    "sessionCapabilities": {
      "additionalDirectories": {}, "close": {}, "delete": {},
      "fork": {}, "list": {}, "resume": {}
    },
    "_meta": { "opencode/child-session-updates": true }
  },
  "authMethods": [
    {
      "id": "opencode-login",
      "name": "Login with opencode",
      "description": "Run `opencode auth login` in the terminal"
    }
  ],
  "agentInfo": { "name": "OpenCode", "version": "2.0.31" }
}
```

### 4.1 字段逐项说明

| 字段 | 取值 | 含义 / 平台侧注意 | 来源 |
| --- | --- | --- | --- |
| `loadSession` | `true` | `session/load` 可用（带回放） | `service.ts:122` |
| `mcpCapabilities.http` | `true` | `session/new` 等可传 HTTP（Streamable）MCP server | `service.ts:123`、`sessions.ts:mcpConfig` |
| `mcpCapabilities.sse` | `false` | **不支持** SSE 型 MCP（v1 曾声明 `true`，v2 收紧为 `false`） | `service.ts:123` |
| `promptCapabilities.embeddedContext` | `true` | 支持 `text` 块 `annotations.audience: ["assistant"]` 的嵌入上下文 | `content.ts:contentBlockToParts` |
| `promptCapabilities.image` | `true` | 支持 `image` 块（`data` base64 或 `uri`） | 同上 |
| `promptCapabilities.audio` | 缺省（不支持） | audio 块被忽略 | `content.ts` `default: return []`；[v2 docs](https://opencode.ai/v2/docs/cli/acp#prompt-content) |
| `sessionCapabilities.list/delete/resume/close/fork/additionalDirectories` | `{}` | 声明支持 `session/list`、`session/delete`、`session/resume`、`session/close`、`session/fork`（fork 为实验特性）、会话生命周期请求上的 `additionalDirectories` | `service.ts:124-125` |
| `sessionCapabilities` 中**无** `configOptions` 声明 | — | 协议 `SessionCapabilities` 无该键；`session/set_config_option` 的支持以会话响应中返回 `configOptions` 为准 | `@agentclientprotocol/sdk@1.6.0` `SessionCapabilities` 类型 |
| `auth`（AgentAuthCapabilities） | 缺省 | 未声明 `auth.logout` 等认证能力 → `logout` 不可用 | `service.ts:118-127` |
| `providers` / `nes` / `positionEncoding` | 缺省 | 均未声明 | 同上 |
| `_meta["opencode/child-session-updates"]` | `true` | **OpenCode 扩展**：告知客户端「若你也支持，请在 clientCapabilities `_meta` 回同名键以接收子会话更新」 | `capabilities.ts:3,11`、`service.ts:126` |

### 4.2 OpenCode 读取的 clientCapabilities

| Client 能力 | 读取效果 | 来源 |
| --- | --- | --- |
| `auth.terminal: true` | `authMethods[0]` 变为终端型认证方法：`{ id, type: "terminal", args: ["--login"] }`；客户端应以 `opencode acp --login` 在终端运行登录流，**不要**把它发给 `authenticate` | `service.ts:112-117`；[v2 docs](https://opencode.ai/v2/docs/cli/acp#authentication) |
| `_meta["terminal-auth"]: true` | `authMethods[0]._meta["terminal-auth"] = { command: "opencode", args: ["auth","login"], label: "OpenCode Login" }`（**OpenCode 扩展**，便于客户端直接渲染登录命令） | `service.ts:114-119` |
| `elicitation.form` | 允许用 `elicitation/create`（form 模式）提问（question 工具/表单） | `capabilities.ts:10`、`elicitation.ts:requestedSchema` |
| `session.compaction` | 用标准 `compaction_update` / `compaction_summary_chunk` 报告压缩；否则退化为 `_meta["opencode/compaction"]` 标记 | `capabilities.ts:9`、`compaction.ts:usesStandardUpdates` |
| `_meta["opencode/child-session-updates"]: true` | 子会话更新改走自定义通知 `opencode/session/child_update`（否则投影进父会话 `session/update`） | `capabilities.ts:7`、`turn.ts:141-148` |
| `fs.*` / `terminal.*` | **读取但不使用**（v2 不调用 fs/terminal 客户端方法） | `connection.ts:53-62` 仅封装 3 个客户端方法 |

---

## 5. 认证与 `logout`

| 项 | 结论 | 证据 |
| --- | --- | --- |
| `authMethods` | 恒为 1 个：`opencode-login`（`name: "Login with opencode"`，`description: "Run \`opencode auth login\` in the terminal"`） | `service.ts:111-120`、实测 |
| `authenticate` | 仅接受 `opencode-login`，不采集凭据，返回 `{}`；其他 methodId → invalid params | `service.ts:131-136` |
| 凭据来源 | 复用 OpenCode 自己的 provider 凭据（`opencode auth login` 在终端预先登录） | [v2 docs](https://opencode.ai/v2/docs/cli/acp#authentication) |
| 未认证报错 | prompt 因 provider 需要认证失败时返回 ACP `auth_required` 错误（`RequestError.authRequired`） | `error.ts`（`ACPAuthRequiredError` → `RequestError.authRequired`）、`translate.ts:failure`（`provider.auth` → `AuthRequiredError`） |
| `logout` | **不支持**（未注册方法；亦未声明 `agentCapabilities.auth.logout`） | `agent.ts` |

---

## 6. 会话生命周期细节

| 行为 | 结论 | 证据 |
| --- | --- | --- |
| `cwd` | 必须绝对路径，否则 invalid params（`field: "cwd"`） | `directories.ts:parseCwd` |
| 目录一致性 | `session/load|resume|fork` 的 `cwd` 必须等于会话归属目录，否则报 `session … does not belong to cwd`（invalid params） | `service.ts:getSession`（`SessionDirectoryMismatchError`） |
| `additionalDirectories` | 支持于 `session/new|load|resume|fork`；必须绝对路径且不含 `*`/`?`；实现方式是给会话追加 `external_directory` allow 规则，并存入会话 metadata 键 `opencode.acp.additionalDirectories`；每次请求的列表**整体替换**旧列表；`session/list` 回显 | `directories.ts`（key 定义在 `directories.ts:12`）；[v2 docs](https://opencode.ai/v2/docs/cli/acp#additional-directories) |
| 历史回放 | 仅 `session/load` 回放（`user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` / `tool_call`+`tool_call_update` / 压缩标记）；`session/resume`、`session/fork` 不回放 | `replay.ts`、`service.ts:152-213` |
| `session/list` | 每页最多 100 条，`order: "desc"`，`cursor` 翻页；`title` 无标题时退化为时间戳标题 | `service.ts:169-193`、`withTimestampedFallback` |
| `session/close` | 中断活动工作 + 分离；已保存会话保留 | `turn.ts:close` |
| `session/delete` | 先取消 prompt 再删；删除不存在会话成功（幂等）；同时分离 ACP 侧登记 | `service.ts:194-205` |
| 并发 | 单会话同时只接受一个 `session/prompt`，第二个直接报错（`Session already has an active ACP prompt`） | `turn.ts:prompt` |
| 取消语义 | `session/cancel` 与 `$/cancel_request` 均结束本轮并 `stopReason: "cancelled"`；挂起的权限/提问被拒绝或取消；未完成工具调用置 `failed` | [v2 docs](https://opencode.ai/v2/docs/cli/acp#cancellation)、`turn.ts:windDown`、`translate.ts:abandon` |
| MCP server 注册 | `mcpServers` 注册到该会话所在目录，**存活期为整个 `opencode acp` 进程**（同目录其他会话也能用）；同名覆盖配置里的 server；HTTP 透传 headers 且 `oauth: false` | `sessions.ts:registerMcp/mcpConfig`；[v2 docs](https://opencode.ai/v2/docs/cli/acp#mcp-servers) |

---

## 7. `session/update` 通知类型清单

OpenCode v2 实际发送的 `sessionUpdate` 类型（证据：`translate.ts`、`turn.ts`、`sessions.ts`、`replay.ts`、`compaction.ts`）：

| sessionUpdate 类型 | 支持 | 触发场景 | 来源 |
| --- | --- | --- | --- |
| `user_message_chunk` | ✅（仅 `session/load` 回放） | 历史用户消息（含附件块） | `replay.ts:updates` |
| `agent_message_chunk` | ✅ | 模型文本输出流式片段 | `translate.ts`（`session.text.delta`） |
| `agent_thought_chunk` | ✅ | 思考/推理片段（messageId 为 `<msgId>:reasoning:<ordinal>`） | `translate.ts:reasoningMessageID` |
| `tool_call` | ✅ | 工具开始（`status: "pending"`，含 `title`/`kind`/`locations`/`rawInput`） | `translate.ts`（`session.tool.input.started`）、`tool.ts:pendingToolCall` |
| `tool_call_update` | ✅ | 工具 `in_progress` / `completed` / `failed`，完成时附内容（text/image/diff） | `tool.ts:runningToolUpdate/completedToolUpdate/errorToolUpdate` |
| `available_commands_update` | ✅ | 会话建立后发送一次；命令集变化时再发；含用户命令 + 内置 `compact` | `sessions.ts:sendCommands`、`catalog.ts:availableCommands` |
| `config_option_update` | ✅ | 模型/agent 列表变化、或**其他客户端**改了该会话的模型/模式时推送 | `sessions.ts:changed` |
| `session_info_update` | ✅（仅带 `_meta`） | 仅用于承载 `opencode/retry`（重试状态）与 `opencode/compaction`（压缩标记）；**不用于** title 等元数据 | `translate.ts:265-275`、`compaction.ts:118` |
| `usage_update` | ✅ | 本轮结束前发送：`used`（当前上下文 token）、`size`（模型上下文窗口）、`cost: {amount, currency:"USD"}`（会话累计） | `turn.ts:sendUsageUpdate` |
| `compaction_update` | ✅（需 `clientCapabilities.session.compaction`） | 压缩 `in_progress`/`completed`/`failed`/`cancelled`，含 `compactionId` 与 `summary` | `compaction.ts:update` |
| `compaction_summary_chunk` | ✅（同上） | 压缩摘要流式片段 | `compaction.ts:chunk` |
| `plan` / `plan_update` / `plan_removed` | ❌ | OpenCode 不向 ACP 暴露执行计划（todo） | 全库无 `plan` update 构造；SDK 类型存在 |
| `current_mode_update` | ❌ | 模式改用 `mode` config option + `config_option_update` 表达（`session/set_mode` 仍实现） | `config-option.ts`、`sessions.ts:changed` |
| `notice` | ❌ | 从不发送（协议要求 `clientCapabilities.session.notices` 才可发） | 无构造代码 |
| `subagent_update` / `session_message` / `session_message_chunk` | ❌（实验特性） | 子会话改用自定义通知 `opencode/session/child_update` + `_meta["opencode/child-session"]` | `child.ts:3` |

### 7.1 权限请求（`session/request_permission`）

| 项 | 内容 | 来源 |
| --- | --- | --- |
| 选项 | 固定三项：`once`（allow_once）/ `always`（allow_always）/ `reject`（reject_once） | `permission.ts:39-43` |
| toolCall 内容 | `toolCallId`、`name`、`title`、`kind`（read/edit/search/execute/fetch/think/other）、`status: "pending"`、`locations`、`rawInput` | `permission.ts:ask`、`tool.ts` |
| diff 预览 | 涉及文件改动时尽力生成 `content` 中的 `diff` 块（`path`/`oldText`/`newText`），`patch` 工具按 hunk 重建 | `permission.ts:withCompletedDiffs/permissionPreviews`；[v2 docs](https://opencode.ai/v2/docs/cli/acp#permissions) |
| 子会话 | 子会话的权限请求带 `toolCall._meta["opencode/child-session"]`，`toolCallId` 加 `<childSessionId>:` 前缀 | `permission.ts:68`、`child.ts:toolCallID` |
| 与 OpenCode 权限体系关系 | ACP 客户端的 allow/reject 即 OpenCode `permission.asked` 的 reply（once/always/reject），`always` 对应工具建议的模式白名单 | `permission.ts:respond`；[v1 docs · Permissions](https://opencode.ai/docs/permissions/) |

---

## 8. Config options / 模式 / 模型切换

`session/new|load|resume|fork` 响应返回 `configOptions`（实测见 `/tmp/opencode/probe-out.json`；源码 `config-option.ts:configOptions`）：

| id | category | 类型 | 取值 | 说明 |
| --- | --- | --- | --- | --- |
| `model` | `model` | select | 全部启用模型，值为 `provider/model` | `value` 亦可带 `/variant` 后缀同时设定 effort |
| `effort` | `thought_level` | select | 该模型的 variants + `default` | **仅当模型有 variants 时出现** |
| `mode` | `mode` | select | 可见主模式（非 subagent、非 hidden 的 agent） | 与 `session/set_mode` 同源 |

- `session/set_config_option` 只接受 `value: string`（非字符串 → invalid params，`field: configId`）；`session/set_mode` 等价于设置 `mode`。来源：`service.ts:230-240`。
- 非法 model/effort/mode 分别报 `model not found` / `effort not found` / `mode not found`（invalid params）。来源：`error.ts:toRequestError`。
- 目录级配置（模型、agent、命令、skill、指令、插件、MCP）在会话创建时按 `cwd` 加载。来源：[v2 docs](https://opencode.ai/v2/docs/cli/acp#sessions)。

---

## 9. Prompt 内容支持

| ContentBlock | v2 行为 | 来源 |
| --- | --- | --- |
| `text` | 进入用户消息 | `content.ts` |
| `text` + `annotations.audience: ["assistant"]` | 作为**嵌入上下文**（synthetic）单独注入，不进用户消息正文 | `content.ts`、`turn.ts:submit`（`session.synthetic`） |
| `text` + `annotations.audience: ["user"]` | 不进模型输入 | `content.ts` |
| `image`（带 `data`） | 作为附件（data URL） | `content.ts` |
| `image`（仅 `uri`） | 按 resource_link 处理 | `content.ts` |
| `resource`（text） | 路径/URI + 文本内联 | `content.ts` |
| `resource`（blob） | 有 `mimeType` 才作为附件，否则丢弃 | `content.ts` |
| `resource_link`（`file://`） | 附件；文件不可读时降级为 Markdown 链接文本 | `prompt.ts:referenceUnreadableFile` |
| `resource_link`（`zed://…?path=`） | 取 `path` 作为附件（编辑器互通优化） | `content.ts:147` |
| `resource_link`（其他 URI） | 降级为 Markdown 链接 | `content.ts:linkReference` |
| `image` 既无 `data` 也无 `uri` | **报错**（invalid params, `field: "prompt"`） | `prompt.ts:prepare` |
| audio | **忽略** | `content.ts` `default: return []` |

`session/prompt` 响应：`stopReason ∈ {end_turn, max_tokens, refusal, cancelled}`，可带 `usage`（`inputTokens/outputTokens/totalTokens/thoughtTokens?/cachedReadTokens?/cachedWriteTokens?`，为本 prompt 在本会话的求和，不含子会话），`_meta` 可能带 `opencode/retry`。来源：`translate.ts:response/resolveStopReason`、[v2 docs](https://opencode.ai/v2/docs/cli/acp#usage)。

---

## 10. Slash 命令

| 项 | 结论 | 来源 |
| --- | --- | --- |
| 命令来源 | 当前 `cwd` 目录的用户自定义命令（`.opencode/commands/*.md`、config `commands`）+ 内置 `compact` | `catalog.ts:builtinCommands`、`config-option.ts:availableCommands` |
| 下发方式 | 会话建立后 `available_commands_update`；命令变化时重发 | `sessions.ts:sendCommands` |
| 执行方式 | prompt 文本以 `/name args` 开头且 name 命中可用命令 → 执行命令（args 透传）；`/compact` → 触发压缩（`session.compact`） | `prompt.ts:detectSlashCommand`、`turn.ts:submit` |
| 未命中的 `/…` | **作为普通 prompt 文本发给模型** | [v2 docs](https://opencode.ai/v2/docs/cli/acp#commands) |
| `/undo`、`/redo`、`/help` 等 TUI 内置命令 | **不支持**（不在 availableCommands 中，只会被当普通文本） | [v1 docs](https://opencode.ai/docs/acp/)（"Some built-in slash commands like /undo and /redo are currently unsupported"）、`catalog.ts` 仅注册 `compact` |
| MCP prompts | v2 中 MCP prompts 会成为 `<server>:<prompt>` 命令（命名归一化），随 `available_commands_update` 下发 | [v2 docs · MCP servers](https://opencode.ai/v2/docs/mcp-servers#names) |

---

## 11. Elicitation（提问 / question 工具）

| 项 | 结论 | 来源 |
| --- | --- | --- |
| 使用条件 | 客户端声明 `elicitation.form`；且表单 kind ∈ {`question`, `websearch.provider`}、无类凭据字段（正则匹配 password/token/api_key 等即放弃）、无 external 字段、无条件字段等 | `elicitation.ts:requestedSchema`（`ElicitedKind`、`Credential`） |
| 请求形态 | `elicitation/create`，`mode: "form"`，含 `sessionId`、`message`、`requestedSchema`（JSON Schema，enum 用 `oneOf: [{const,title}]`）、可选 `toolCallId` | `elicitation.ts:ask`；[v2 docs](https://opencode.ai/v2/docs/cli/acp#questions) |
| 自定义输入 | 自由输入项生成附加属性 `<key>_custom`；单选取值覆盖选项，多选取值追加 | `elicitation.ts:other/customKey/fieldAnswer` |
| 取消语义 | 用户拒绝/取消 → 取消该 question；无法展示（客户端不支持/表单不可表达）→ 取消并让模型「无答案继续」（`UnshownQuestionMessage`） | `elicitation.ts:cancelUnshown` |
| `elicitation/create` 的 `url` 模式 | **不使用**（仅 `mode: "form"`） | `elicitation.ts:ask` |
| `elicitation/complete` 通知 | **不发送** | `connection.ts` 未封装 |

---

## 12. Compaction（上下文压缩）

| 客户端能力 | 行为 | 来源 |
| --- | --- | --- |
| 声明 `session.compaction` | 发 `compaction_update`（`in_progress`/`completed`/`cancelled`/`failed`，`compactionId`、`summary`）+ `compaction_summary_chunk`；`session/load` 时把已完成/失败的压缩各回放一条 | `compaction.ts` |
| 未声明 | 退化为 `session_info_update` + `_meta["opencode/compaction"]`（`{status, messageId, reason, error?}`，无摘要）；**子会话的压缩恒用此标记** | `compaction.ts:usesStandardUpdates` |
| 手动压缩 | `/compact`（内置命令）→ `session.compact` | `catalog.ts:9`、`turn.ts:submit` |

---

## 13. Usage（用量）

| 项 | 内容 | 来源 |
| --- | --- | --- |
| `PromptResponse.usage` | 本 prompt 的模型调用求和：`inputTokens/outputTokens/totalTokens/thoughtTokens?/cachedReadTokens?/cachedWriteTokens?`（end-turn usage RFD，draft） | `translate.ts:response` |
| `usage_update` | 仅当 prompt 消耗 token 且已知模型上下文窗口时发送：`used`（当前上下文占用）、`size`（窗口）、`cost: {amount, currency: "USD"}`（会话累计成本）。实现口径：`used = TokenUsage.total(最近一次模型调用)` = input+output+reasoning+cache.read+cache.write | `turn.ts:sendUsageUpdate`、`packages/schema/src/token-usage.ts:16` |

---

## 14. 作为 Client 侧（被托管时）调用的客户端方法

OpenCode 是「自己处理文件与终端」的 Agent，不把 IO 委托给客户端：

| 客户端方法 | v2 是否调用 | v1 是否调用 | 说明 | 来源 |
| --- | --- | --- | --- | --- |
| `session/update` | ✅ | ✅ | 全部进度更新 | v2 `connection.ts:53` |
| `session/request_permission` | ✅ | ✅ | 权限请求 | v2 `connection.ts:54-57` |
| `elicitation/create` | ✅ | ❌ | 表单提问 | v2 `connection.ts:58-62` |
| `opencode/session/child_update`（**自定义通知**） | ✅（需客户端 `_meta` opt-in） | ❌ | 子会话状态/更新 | `child.ts:3`、`turn.ts:141-148` |
| `fs/read_text_file` | ❌ | ❌ | 文件读取走 OpenCode 自己的 `read` 工具 | v2 `connection.ts` 未封装 |
| `fs/write_text_file` | ❌ | ✅（有限） | v1 在用户批准 edit 权限后调用 `writeTextFile` 把补丁应用结果写回客户端文件（`writeProposedEdit`） | v1 `permission.ts:80-110` |
| `terminal/create` / `output` / `release` / `wait_for_exit` / `kill` | ❌ | ❌ | shell 命令由 OpenCode 自己的 shell/bash 工具在 Agent 侧执行 | `connection.ts` 未封装；[v2 tools 文档](https://opencode.ai/v2/docs/tools) |
| `elicitation/complete` | ❌ | ❌ | 不发送 | 同上 |
| `mcp/message` | ❌ | ❌ | 不支持 MCP over ACP | [v2 docs](https://opencode.ai/v2/docs/cli/acp#mcp-servers) |

> 平台侧含义：托管 OpenCode 时**不能**依赖 `fs/*`/`terminal/*` 做沙箱化文件/终端代理；OpenCode 的 shell 工具拥有 Agent 进程用户的完整文件系统/进程/网络权限，只能用其自身 permission 体系（`bash`/`edit`/`read`/`external_directory` 等）约束。

---

## 15. 扩展机制（`_meta` 与自定义方法）汇总

| 扩展 | 类型 | 方向 | 内容 | 来源 |
| --- | --- | --- | --- | --- |
| `opencode/child-session-updates` | `initialize` 双方 `_meta` | Agent 声明 → Client 回应 | 客户端回 `true` 后，子会话更新走自定义通知 | `capabilities.ts:3` |
| `opencode/session/child_update` | **自定义通知方法**（未用 `_` 前缀，属开放命名空间用法） | Agent → Client | `{rootSessionId, childSessionId, parentSessionId, depth, title?, type: "update"|"status"}` | `child.ts:3-26` |
| `opencode/child-session` | `_meta`（session update / toolCall） | Agent → Client | `{id, parentID, depth, title?}`；未 opt-in 时子会话更新同样带此键（投影进父会话） | `child.ts:meta` |
| `opencode/retry` | `_meta`（`session_info_update` 与 `PromptResponse`） | Agent → Client | `{attempt, nextRetryAt, error}`；重试开始时置 `null`；prompt 响应到达时清空 | `translate.ts:19` |
| `opencode/compaction` | `_meta`（`session_info_update`） | Agent → Client | `{status, messageId, reason, error?}`（无 compaction 能力时的压缩标记） | `compaction.ts:6` |
| `terminal-auth` | `authMethods[0]._meta` | Agent → Client | `{command: "opencode", args: ["auth","login"], label}`（客户端 `_meta["terminal-auth"]: true` 时） | `service.ts:114-119` |
| `opencode.acp.additionalDirectories` | 会话 **metadata** 键（非 `_meta`） | Agent 内部 | 保存该 ACP 会话的附加目录授权 | `directories.ts:12` |
| `ai.opencode/sessionID` | MCP `tools/call` 的 `_meta` | Agent → MCP server | 会话关联 ID（非 ACP，但为 OpenCode 扩展惯例） | [v2 docs · MCP](https://opencode.ai/v2/docs/mcp-servers#context) |

> 注意：`opencode/session/child_update` **没有**使用 ACP 保留的 `_` 前缀扩展方法命名（规范建议自定义方法以 `_` 开头，见 [Extensibility](https://agentclientprotocol.com/protocol/v1/extensibility)），客户端应按「未知方法可忽略/不响应」处理。

---

## 16. 「支持 / 部分支持 / 不支持」三档清单

### ✅ 支持

| 能力 | 备注 |
| --- | --- |
| `initialize` / `authenticate`（`opencode-login`） | protocolVersion 1 |
| `session/new` / `prompt` / `cancel` / `$/cancel_request` | 基线方法齐全 |
| `session/load`（带回放）/ `resume` / `close` / `list` / `delete` / `fork` | 均在 `sessionCapabilities` 声明 |
| `session/set_mode`、`session/set_config_option`（model/effort/mode） | config 项为 select 型 |
| `session/update`：message/thought chunk、tool_call(+update)、available_commands_update、config_option_update、usage_update、session_info_update(_meta) | |
| `session/request_permission`（once/always/reject，含 diff 预览） | 映射到 OpenCode permission 体系 |
| `elicitation/create`（form 模式） | question 工具/表单 |
| compaction（标准 updates 或 `_meta` 标记）、usage（`usage_update` + `PromptResponse.usage`） | 按客户端能力降级 |
| 图片、嵌入上下文（assistant audience）、resource/resource_link | |
| `additionalDirectories` | 映射 `external_directory` 授权 |
| MCP：stdio + HTTP（经 `session/new` 注入；配置文件中的 server 亦生效） | |
| 自定义工具、slash 命令、AGENTS.md 规则、formatter/linter、多 agent（mode） | [v1 docs · Support](https://opencode.ai/docs/acp/) |

### ⚠️ 部分支持

| 能力 | 缺口 | 依据 |
| --- | --- | --- |
| Slash 命令 | 仅目录命令 + `compact`；其他 `/…` 透传为普通文本 | `catalog.ts:9`；[v2 docs](https://opencode.ai/v2/docs/cli/acp#commands) |
| 认证 | 只有一种 `opencode-login`（终端登录），`authenticate` 本身不采集凭据；无 `logout` | `service.ts:111-136` |
| Elicitation | 仅 form 模式；涉密/复杂表单不走 elicitation（取消并让模型继续）；无 `url` 模式、无 `elicitation/complete` | `elicitation.ts` |
| Compaction | 需客户端 `session.compaction` 才有摘要流；否则仅标记 | `compaction.ts` |
| `session_info_update` | 仅承载 `_meta` 扩展，不更新 title 等元数据 | `translate.ts:265-275` |
| 模型/模式切换 | 只有 select 型 config option，无 boolean config option；`session/set_model`（unstable）在 v2 已移除 | `service.ts:232`（`typeof value !== "string"` 即拒绝） |
| MCP | 仅 stdio + HTTP；SSE 不支持（`mcpCapabilities.sse: false`）；注入的 HTTP server 不走 OAuth；MCP over ACP 不支持 | `service.ts:123`、`sessions.ts:mcpConfig` |
| 子会话（subagent）可见性 | 仅在客户端 opt-in 自定义 `_meta` 后通过自定义通知暴露；不支持协议实验的 `subagent_update`/`session_message` | `child.ts` |
| 模型重试状态 | 仅 `_meta["opencode/retry"]`（session_info_update + PromptResponse），无独立 update 类型 | `translate.ts:19` |

### ❌ 不支持

| 项 | 说明 | 依据 |
| --- | --- | --- |
| `logout` | 未注册方法 | `agent.ts` |
| `providers/list` / `providers/set` / `providers/disable` | 未注册、未声明 `providers` 能力 | `agent.ts` |
| `nes/*`、`document/did*` | 未注册（Next Edit Suggestions、文档同步） | `agent.ts` |
| `mcp/message`（MCP over ACP） | 明确不支持 | [v2 docs](https://opencode.ai/v2/docs/cli/acp#mcp-servers) |
| `plan` / `plan_update` / `plan_removed` | 不暴露执行计划 | 无构造代码 |
| `notice` | 从不发送 | 无构造代码 |
| `current_mode_update` | 用 config option 替代 | `config-option.ts` |
| `subagent_update` / `session_message` / `session_message_chunk` | 用自有扩展替代 | `child.ts` |
| audio prompt 块 | 忽略 | `content.ts` |
| 客户端 `fs/*`、`terminal/*` 代理 | 自行处理 | `connection.ts` |
| `elicitation/complete` | 不发送 | `connection.ts` |
| TUI 内置 slash 命令 `/undo`、`/redo`、`/help` 等 | 不在可用命令列表，按普通文本处理 | [v1 docs](https://opencode.ai/docs/acp/)、`catalog.ts` |
| 未知扩展方法（如 `_opencode/ping`、`fs/read_text_file` 发给 Agent） | 返回 `-32601 Method not found`（实测） | `/tmp/opencode/probe-out.json` |

---

## 17. MCP / 工具 / 命令 / 权限 能力映射（ACP 视角）

### 17.1 MCP

| 项 | 映射 | 来源 |
| --- | --- | --- |
| `session/new` 的 `mcpServers` | 支持无 `type`（stdio：`command/args/env`）与 `type: "http"`（`url/headers`）；`type: "acp"`/`"sse"` → invalid params（"Only stdio and HTTP MCP servers are supported"） | `service.ts:supportedMcpServers`、`sessions.ts:mcpConfig` |
| 配置文件 `mcp.servers` | 同样生效（`opencode acp` 使用 `cwd` 目录配置） | [v2 docs](https://opencode.ai/v2/docs/mcp-servers) |
| MCP 工具可见性 | 作为 OpenCode 工具出现在 `tool_call`（kind 映射见下），默认经 Code Mode `execute` 聚合 | [v2 tools](https://opencode.ai/v2/docs/tools#extensions) |
| MCP prompts | 变成 `<server>:<prompt>` 命令，经 `available_commands_update` 下发 | [v2 docs · MCP](https://opencode.ai/v2/docs/mcp-servers#names) |

### 17.2 工具 → ACP `ToolCall.kind`（`tool.ts:toToolKind`）

| OpenCode 工具 | kind |
| --- | --- |
| `shell` / bash | `execute` |
| `read` | `read` |
| `edit` / `write` / `patch`（apply_patch） | `edit` |
| `grep` / `glob` / `context`（及 context7 工具） | `search` |
| `webfetch` | `fetch` |
| `subagent` | `think` |
| 其他（websearch、question、skill、MCP 工具等） | `other` |

### 17.3 权限

- OpenCode 的 permission 体系（`read`/`edit`/`glob`/`grep`/`bash`/`task`/`skill`/`lsp`/`question`/`webfetch`/`websearch`/`external_directory`/`doom_loop`，allow/ask/deny）**在 ACP 下照常生效**；`ask` 转化为 `session/request_permission`，`always` 落到工具建议的模式白名单。来源：[v1 docs · Permissions](https://opencode.ai/docs/permissions/)、`permission.ts`。
- `additionalDirectories` 直接落为 `external_directory` allow 规则（`<dir>/*`）。来源：`directories.ts:rules`。

---

## 18. v1 与 v2 差异（对平台适配重要）

| 维度 | v1（tag v1.17.9，SDK 0.21.0） | v2（dev/2.1.1，SDK 1.6.0，实测 2.0.31） |
| --- | --- | --- |
| 方法集 | initialize/authenticate/new/load/list/resume/close/fork(unstable)/set_config_option/set_mode/**set_model(unstable)**/prompt/cancel；**无 session/delete** | 全量 14 方法 + **session/delete**；移除 `set_model`（并入 config option） |
| `agentCapabilities` | `loadSession: true`；`mcpCapabilities: {http: true, **sse: true**}`；`promptCapabilities: {embeddedContext, image}`；`sessionCapabilities: {close, fork, list, resume}`；**无 `_meta`** | `mcpCapabilities.sse: false`；`sessionCapabilities` 增 `additionalDirectories`、`delete`；`_meta["opencode/child-session-updates"]` |
| 客户端方法 | `session/update`、`session/request_permission`、**`fs/write_text_file`**（edit 批准后写回） | 前两者 + `elicitation/create` + `opencode/session/child_update`；**不用 fs/** |
| session/update 类型 | user_message_chunk、agent_message_chunk、agent_thought_chunk、tool_call(+update)、available_commands_update、usage_update | 增加：config_option_update、session_info_update(_meta)、compaction_update、compaction_summary_chunk |
| elicitation | 不支持 | 支持 form 模式 |
| 子会话/重试/压缩标记扩展 | 无 | `opencode/*` 系列 `_meta` 全套 |
| `additionalDirectories` | 不支持 | 支持 |
| 文档 | https://opencode.ai/docs/acp/ （仅配置 + 支持声明） | https://opencode.ai/v2/docs/cli/acp （含完整 Protocol reference） |

---

## 19. 编辑器集成配置（ACP Client 侧）

统一入口：让客户端以子进程运行 `opencode acp`（stdio）。来源：[v1 docs · ACP](https://opencode.ai/docs/acp/)、[v2 docs · ACP](https://opencode.ai/v2/docs/cli/acp)。

| 编辑器 | 配置 |
| --- | --- |
| **Zed** | 首选：Command Palette 运行 `zed: acp registry` 从 ACP Registry 安装；或 `~/.config/zed/settings.json`：`{"agent_servers": {"OpenCode": {"type": "custom", "command": "opencode", "args": ["acp"]}}}`；可用 `keymap.json` 绑定 `agent::NewExternalAgentThread` |
| **JetBrains** | `acp.json`：`{"agent_servers": {"OpenCode": {"command": "/absolute/path/bin/opencode", "args": ["acp"]}}}`，在 AI Chat 的 agent 选择器中选 OpenCode |
| **Avante.nvim** | `acp_providers = { ["opencode"] = { command = "opencode", args = { "acp" }, env = { OPENCODE_API_KEY = os.getenv("OPENCODE_API_KEY") } } }` |
| **CodeCompanion.nvim** | `require("codecompanion").setup({ interactions = { chat = { adapter = { name = "opencode", model = "claude-sonnet-4" } } } })` |
| 通用 | 图形客户端找不到 `opencode` 时用 `which opencode` 的绝对路径；排错加 `--print-logs`；Windows 详见 https://opencode.ai/docs/windows-wsl |

补充：OpenCode 自身能力在 ACP 下与终端一致——内置工具、自定义工具与 slash 命令、MCP、AGENTS.md 规则、formatter/linter、agent 与权限体系均支持（[v1 docs · Support](https://opencode.ai/docs/acp/)）。

---

## 20. 信息缺口 / 待验证项

1. **v1 行为未实测**：v1 结论来自 tag `v1.17.9` 源码，未对真实 v1 二进制跑探针；`available_commands_update` 在 v1 是否包含 TUI 内置命令（`/undo` 等）未逐行确认（v1 `directory.ts` 的 `availableCommands` 来源未深挖）。
2. **`opencode/session/child_update` 命名合规性**：未使用 ACP 保留的 `_` 前缀扩展方法名，是否与未来协议方法冲突存在不确定性；平台侧建议按「未知方法容错」处理。
3. **`session_info_update` 语义偏差**：协议定义该 update 为 session 元数据（如 title）变更，OpenCode 仅用其承载 `_meta` 扩展；若平台据标准语义渲染，需兼容「无字段变更」的 update。
4. **`usage_update.used` 计算口径**：v2 为「最近一次模型调用的上下文占用」（`state.usage.last` 求和口径与 v1 的 `input + cache.read` 略不同），跨版本对比数值时需注意。
5. **`effort`/variant 语义**：`model` value 带 `/variant` 后缀同时设置 effort 的行为在文档与代码一致，但不同 provider 的 variant 命名（`default`/`high`/`low`）依赖模型目录，需按实际 provider 验证。
6. **实验特性跟踪**：ACP 侧 `subagent_update`/`session_message`/`plan_update`/`notice`/`nes`/`providers` 均标 UNSTABLE（SDK 注释），OpenCode 未来可能改用标准机制替代自有 `_meta` 扩展，需要持续跟踪 `packages/cli/src/acp/` 变更。
7. **v2.0.31 与 dev(2.1.1) 的差异**：实测仅覆盖 `initialize`/`session/new`/`session/prompt`/`session/list`/未知方法探测；`session/fork`、`session/delete`、elicitation、compaction 降级、子会话通知未做端到端实测（以源码 + 官方文档为准）。
8. **权限 diff 预览的完备性**：`patch`/`write`/`edit` 各工具的 diff 预览生成有条件分支（如 patch hunk 重建比对失败则不给预览），客户端不应假设一定有 `diff` content。
9. **Windows 路径行为**：`directories.ts` 有 `FSUtil.windowsPath` 处理，未在 Windows 环境实测。
10. **Zed registry 版本**：Zed ACP Registry 中 OpenCode 的发布版本与本地版本可能不一致（registry 安装与自定义命令两种方式行为应一致，但未验证）。
