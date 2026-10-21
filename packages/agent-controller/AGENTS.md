# agent-gear

## Tech Stack

- **Runtime**: Node.js 24+ with TypeScript (strict mode, ESM)
- **CLI**: commander
- **Config**: smol-toml (~/.zag/config.toml)
- **Communication**: socket.io-client
- **Testing**: Vitest

## Architecture

```
src/
├── index.ts              # Entry point: CLI parsing + daemon startup（`--version` 取自 package.json）
├── config.ts             # Key/endpoint reading with priority chain
├── socketio-client.ts    # Socket.IO client connection + event handling（register 上报完整版本）
├── heartbeat.ts          # Heartbeat sender (30s interval)
├── workload-executor.ts  # 工作负载脚本串行执行（超时/截断/重连重放）+ 参数/容器 env 注入 + secret 脱敏
├── daemon.ts             # Daemon management (PID file, signal handling)
├── cloud-host/
│   └── supervisor.ts     # 云电脑双连接（/worker → controller-api）与 init 等待编排
├── harness/
│   ├── env.ts            # harness env 校验（ZAG_MODEL_* / ZAG_DEFAULT_WORKSPACE）
│   ├── opencode-cli.ts   # `opencode --version` 硬校验（兼容 `-v`）
│   ├── opencode-config.ts# opencode.jsonc 定位/合并（保留注释，仅替换 provider.zag，0600）
│   └── prepare.ts        # `harness prepare` 编排 + 摘要（不含 secret）
└── commands/
    ├── harness.ts        # `agent-gear harness prepare`
    ├── mcp.ts
    └── mcp-proxy.ts
```

## 工作负载参数注入

`workload:run` 的每个 item 可携带 `workloadId` 与 `params`；`workload-executor` 对每个 item 以 `process.env` 为基础注入后执行 `bash -c <script>`（不修改脚本文本）：

| 环境变量 | 值 |
|---------|----|
| `WORKLOAD_PARAMS` | 完整参数 JSON 字符串（无参数为 `{}`） |
| `WORKLOAD_PARAM_<KEY_UPPER>` | 单个参数值：字符串原样、布尔 `"true"`/`"false"`、多选为 JSON 数组字符串（如 `["pnpm"]`） |

- 参数 env 仅对当前 item 生效，不污染后续脚本；`params` 缺省 `{}` 时行为与旧版一致。
- 参数只作为脚本入参，不改变执行边界、超时与权限。

## 工作负载「必须」短路（工作负载三期）

- `workload:run` 的 `items[]` 可携带 `required: boolean`（缺省 `false`）。仅当 `phase=init` 且
  `item.required === true` 时，该条结果为 `failed`/`timeout` 后**不再启动后续条目**（上报本条结果即结束本批）。
- 该短路仅是**省时优化**：必须项的失败裁决、剩余初始化中断与容器强制注销均由 cloud-controller
  `workload-dispatcher` 独占；旧 worker 忽略 `required` 不影响正确性。
- `post` 批次不参与必须判定（`required` 固定 `false`，即使携带 `true` 也不短路）。
- 无 `required` 字段时行为与旧版完全一致（非必须项失败后继续执行后续条目）。

- 版本：包版本 `2.5.0`（major 保持 2；云电脑双连接 / `harness prepare`，cloud-controller 对
  `purpose=harness` 的 `MIN_HARNESS_WORKER_VERSION` 为 `2.5.0`）。参数注入需 `>=2.3.0`、`items[].required`
  短路需 `>=2.4.0`；普通容器 `MIN_WORKER_VERSION` 仍为 `2.2.0`（服务端为唯一裁决，旧 worker 忽略
  `required` 仍正确）。

## 容器级 env 与 secret 脱敏（2.5.0）

`workload:run` 可携带容器级 `env`（仅 `purpose=harness` 下发，如 `ZAG_MODEL_*` / `ZAG_HOST_*` /
`ZAG_DEFAULT_WORKSPACE`）。每个 item 的执行环境合并顺序：

```
process.env  →  容器 env（批次内所有 item）  →  WORKLOAD_PARAMS / WORKLOAD_PARAM_*（item 参数优先）
```

- `ZAG_MODEL_API_KEY` / `ZAG_HOST_KEY` / `ZAG_CONTROLLER_KEY` 的值在**脚本输出、日志、错误**中统一替换为
  `***`（`redactSecrets`；日志中的 `workload:run` payload 同样脱敏）。
- 普通容器不携带 `env`，行为与旧版完全一致。

## 云电脑模式（cloud-host supervisor）

入口默认 action 检测 `ZAG_HOST_ENDPOINT` + `ZAG_HOST_KEY` + `ZAG_CONTROLLER_KEY`（三者同时非空）：

| 连接 | endpoint env | 凭据 env | 职责 |
|------|--------------|----------|------|
| `/worker`（cloud-controller） | `ZAG_SERVER_ENDPOINT` | `ZAG_CONTROLLER_KEY`（一次性 token） | 生命周期 / 初始化脚本 |
| controller-api 标准连接 | `ZAG_HOST_ENDPOINT` | `ZAG_HOST_KEY`（仅握手 `auth.token`，不入 URL） | 会话 / ACP / 工作区 / 心跳 |

- 先连 `/worker`：`registered.initializing=true` 时等待首个 `workload:run` init 批次结束（成功/失败）后
  再连 controller-api；`false`/缺省立即连接；等待上限 `HARNESS_INIT_WAIT_MS`（默认 10 分钟）。
  **被打断（cancelled）的批次不算完成**（重连重放时继续等待）；超时后迟到的 `registered` 不再次进入等待。
- 启动时 `mkdir -p ZAG_DEFAULT_WORKSPACE`（默认 `/root/workspace`，幂等）。
- 云电脑两端连接均 `persistConfig=false`：**不读写** `~/.zag/config.toml`（不落 resumeToken/Key）；
  本地单连接保持原行为，配置写入使用权限 `0600`。
- 任一端 `shutdown` → 关闭两端并退出：正常（服务端主动 shutdown/SIGTERM/SIGINT）退出 0；`version_mismatch:*` / `error:*` / 必须工作负载初始化失败退出 1（entrypoint 自愈与失败语义）；**不发送 `unregister`**（容器销毁由 agent-api 编排）。
- `KEY_ALREADY_ONLINE` 在云电脑模式按 1s→2s→…→30s 退避手动重连；**仅在 `registered` 成功后重置退避计数**（connect 先于 register 结果，不能作为成功信号）。退避定时器不 `unref`，避免双端断开时进程静默退出。
- 双连接只启动一个 `LocalMcpServer`：`/worker` 连接 `skipLocalMcpStart=true`，标准连接负责启动。
- 未检测到云电脑模式时保持本地控制器单连接旧行为不变。

## harness prepare（OpenCode）

init 脚本（admin-api 迁移 005）在安装固定版本 OpenCode 后执行 `agent-gear harness prepare`：

1. 校验 `ZAG_MODEL_BASE_URL` / `ZAG_MODEL_API_KEY` / `ZAG_MODEL_IDS`（JSON 数组，去空去重）/
   `ZAG_DEFAULT_WORKSPACE`；缺失项按变量名报错并非零退出（不泄漏其它 env 值）。
2. `opencode --version` 硬校验（旧版兼容 `opencode -v`），失败非零退出。
3. `mkdir -p ZAG_DEFAULT_WORKSPACE`。
4. 定位 `~/.config/opencode/opencode.jsonc`：同目录已有 `.json` 且无 `.jsonc` 时合并 `.json`；否则新建
   `.jsonc`。使用 `jsonc-parser` 保留注释与既有 provider，仅替换 `provider.zag`；权限 0600。
   `provider.zag = { npm: '@ai-sdk/openai-compatible', name: 'ZAG', options: { baseURL, apiKey }, models: { <id>: { name: <id> } } }`。

> 镜像**不预装** `@opencode/cli`，由 harness 工作负载按 `OPENCODE_CLI_VERSION` 固定版本安装。

## Dev Commands

```bash
aspire start     # 启动 Aspire 编排（拉起全部服务）
npm run build    # Compile TypeScript
npm run start    # Start production controller
npm run test     # Run tests
```

## Development with Aspire

使用 Aspire 编排启动所有服务后，再启动 agent-gear 连接 controller-api。

### 启动流程

```bash
# 1. 启动 Aspire 编排（拉起 agent-api + controller-api + MongoDB + Redis + agent-web）
aspire start

# 2. 使用 aspire describe 查看 controller-api 的 HTTP endpoint

# 3. 先通过 agent-api 生成 Key（GraphQL Playground: http://localhost:4000/graphql）
#    mutation { createControllerKey(input: { name: "dev", type: local }) { rawKey } }

# 4. 使用生成的 Key 启动 agent-gear
npm run dev -- --key <rawKey> --server <controller-api-endpoint>
```

### 示例

```bash
# Aspire 启动后 controller-api 在 4001 端口
npm run dev -- --key zag_k_1_abc123... --server http://localhost:4001

# 或使用环境变量
ZAG_CONTROLLER_KEY=zag_k_1_abc123... ZAG_SERVER_ENDPOINT=http://localhost:4001 npm run dev
```

## Config Priority

- `--key` > `~/.zag/config.toml` > `ZAG_CONTROLLER_KEY` env
- `--server` > `~/.zag/config.toml` > `ZAG_SERVER_ENDPOINT` env

## TDD Workflow

本项目采用测试驱动开发（TDD）模式，遵循红-绿-重构循环：

1. **RED**: 编写一个失败测试
2. **GREEN**: 编写最少代码使测试通过
3. **REFACTOR**: 重构代码，保持测试通过

详细指南请参考：[TDD Skill](../../.agents/skills/tdd/SKILL.md)

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)

## Lessons Learned

### 跨服务协议必须有双向集成测试

本次 Proxy timeout bug 的根因是 agent-controller 没有理解 controller-api 发送的 `http-request` JSON 协议，直接把 JSON 字符串当原始 TCP 数据写入了目标服务。测试未覆盖的原因：

| 测试层 | 为什么没发现问题 |
|--------|----------------|
| `gateway.test.ts`（agent-controller 单元测试） | `handleTunnelData` 只测了纯 TCP 数据（`Buffer.from('test payload')`），从未构造 `http-request` JSON 作为输入 |
| `gateway-relay.test.ts`（controller-api 单元测试） | Mock 了 Socket.IO 层，构造的 `http-response` 数据格式与 agent-controller 实际发送的格式不一致，但测试双方各自通过 |
| `gateway-proxy.test.ts`（agent-api 单元测试） | Mock 了整个 Redis Pub/Sub 层，无法检测 controller-api ↔ agent-controller 之间的协议不匹配 |
| E2E 测试 | Fake controller 的协议实现与真实 agent-controller 不同，掩盖了问题 |

**教训**：
1. **协议变更时必须同时更新两端的测试** — 当 controller-api 引入 `http-request`/`http-response` 协议时，agent-controller 侧没有添加对应的输入/输出测试用例
2. **Mock 隔离测试无法验证跨服务协议匹配** — 即使两端各自单元测试通过，真实交互仍可能失败。关键协议边界需要集成测试
3. **伪造实现 vs 真实实现的差异不可忽略** — E2E 的 fake controller 不应与真实 agent-controller 在协议处理上存在差异

**改进措施**：
- 引入新协议或修改现有协议时，先编写跨服务的集成测试（启动真实 agent-controller 或 mock 端精确模拟协议格式）
- handleTunnelData 的测试必须覆盖所有入站数据类型（纯 TCP 数据 + JSON 协议数据）
- handleTunnelData 的出站（localSocket.on('data')）测试必须验证响应格式与 controller-api 端期望的格式一致
