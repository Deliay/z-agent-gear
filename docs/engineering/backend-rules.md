# Backend Development Rules

## Tech Stack

- **Runtime**: Node.js 24+ with TypeScript (strict mode)
- **Framework**: Express (v5) with GraphQL-Yoga
- **ORM/ODM**: Mongoose (MongoDB ODM)
- **API Style**: GraphQL (primary) + REST health endpoints
- **Testing**: Vitest
- **Package Manager**: npm
- **Module System**: ESM (`"type": "module"`)
- **Formatter**: Prettier
- **Dev Runner**: tsx (watch mode)

## Project Structure

```
servers/agent-api/
├── src/
│   ├── config/           # Configuration (env, db, etc.)
│   ├── graphql/
│   │   ├── schemas/      # GraphQL type definitions
│   │   └── resolvers/    # GraphQL resolvers
│   ├── models/           # Mongoose models
│   ├── services/         # Business logic layer
│   ├── middleware/       # Express middleware
│   └── index.ts          # Entry point
├── tests/
├── contracts/            # GraphQL schema files (referenced from root)
├── tsconfig.json
└── package.json
```

## GraphQL Conventions

- Define schema and resolvers in separate files.
- Use `@graphql-tools/schema` for schema stitching.
- Keep resolvers thin; delegate business logic to services.

## Naming Conventions

- **Files**: `kebab-case` (e.g., `agent-resolver.ts`)
- **Classes**: `PascalCase`
- **Functions/Variables**: `camelCase`
- **GraphQL Types**: `PascalCase`
- **Environment Variables**: `UPPER_SNAKE_CASE`
