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
