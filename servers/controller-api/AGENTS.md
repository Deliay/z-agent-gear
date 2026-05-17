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
npm run dev     # Start dev server with hot reload
npm run build   # Compile TypeScript
npm run start   # Start production server
npm run test    # Run tests
```

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
- [Backend Rules](../../docs/engineering/backend-rules.md)
