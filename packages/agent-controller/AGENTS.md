# agent-controller

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
npm run dev     # Start controller
npm run build   # Compile TypeScript
npm run start   # Start production controller
npm run test    # Run tests
```

## Config Priority

- `--key` > `~/.zag/config.toml` > `ZAG_CONTROLLER_KEY` env
- `--server` > `~/.zag/config.toml` > `ZAG_SERVER_ENDPOINT` env

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
