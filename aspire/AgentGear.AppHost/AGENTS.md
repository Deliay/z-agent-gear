# AgentGear.AppHost

## Tech Stack

- **Orchestrator**: .NET Aspire 13.x
- **Runtime**: .NET 10
- **Infrastructure**: MongoDB (container), Redis (container)
- **Resources**: Node.js apps managed as executables

## Managed Resources

| Resource   | Type       | Port |
|------------|------------|------|
| agent-api  | Node.js    | 4000 |
| agent-web  | Node.js    | 5173 |
| mongodb    | Container  | 27017|
| redis      | Container  | 6379 |

## Dev Commands

```bash
dotnet run     # Start Aspire orchestration dashboard
```

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
