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
aspire start   # Start Aspire orchestration (all services)
aspire stop    # Stop orchestration
aspire describe # List resources and status
```

## Related Rules

- [Common Rules](../../docs/engineering/common-rules.md)
