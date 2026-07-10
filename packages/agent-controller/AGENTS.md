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
├── index.ts              # Entry point: CLI parsing + daemon startup
├── config.ts             # Key/endpoint reading with priority chain
├── socketio-client.ts    # Socket.IO client connection + event handling
├── heartbeat.ts          # Heartbeat sender (30s interval)
└── daemon.ts             # Daemon management (PID file, signal handling)
```

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
