# controller-api

## Tech Stack

- **Runtime**: Node.js 24+ with TypeScript (strict mode, ESM)
- **Framework**: Express v5 + Socket.IO
- **ODM**: Mongoose (MongoDB, shared with agent-api)
- **Cache**: Redis (via ioredis, session + heartbeat)
- **Dev Runner**: tsx (watch mode)
- **Testing**: Vitest

## Architecture

```
src/
├── config/           # Environment configuration
├── services/
│   ├── socketio.ts   # Socket.IO server + event handling
│   ├── session.ts    # Session management (single key per session)
│   ├── heartbeat.ts  # Heartbeat detection + timeout scanner
│   └── command.ts    # Redis Pub/Sub command subscription
├── models/           # Mongoose models (shared schemas with agent-api)
├── middleware/
│   └── redis.ts      # Redis client initialization
└── index.ts          # Entry point
```

## Dev Commands

```bash
aspire start    # Start all services via Aspire orchestration
npm run build   # Compile TypeScript
npm run start   # Start production server
npm run test    # Run tests
```

本项目由 Aspire 编排启动，无需单独运行 `npm run dev`。使用 `aspire describe` 查看 controller-api 的 HTTP endpoint。

## TDD Workflow

本项目采用测试驱动开发（TDD）模式，遵循红-绿-重构循环：

1. **RED**: 编写一个失败测试
2. **GREEN**: 编写最少代码使测试通过
3. **REFACTOR**: 重构代码，保持测试通过

详细指南请参考：[TDD Skill](../../.agents/skills/tdd/SKILL.md)

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
- [Backend Rules](../../docs/engineering/backend-rules.md)
