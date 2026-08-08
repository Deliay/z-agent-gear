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

## Pitfalls & Lessons

### 并发与顺序

- **「落库后推送」的并发写入必须用序字段或串行化兜底**。`create` 时同步生成 ObjectId、`await` 之后再 publish 的写法，在并发下必然导致「推送序 ≠ `_id` 序」。凡依赖推送顺序的链路（SSE 直推、chunk 拼接），写入方应针对同一 key（如 sessionId）做 per-key 串行化，保证落库序 = 到达序 = 推送序。

### Mongoose

- **嵌套子文档必须考虑 Mongoose 空对象物化**。schema 声明的 nested subdocument 即使从未赋值也会以 `{}` 出现，GraphQL 非空字段会直接崩查询。新增嵌套结构时应同步添加字段 resolver 归一化（空为 null），并用 API 测试覆盖「混合类型列表 + 消费方真实查询字段」。
- **resolver 合并清单是隐性陷阱**。`resolvers/index.ts` 手工枚举合并键，新增类型级 resolver（非 Query/Mutation）时必须登记，否则单元测试（直接引用 resolver 对象）无法发现未生效。

### 聚合信息

- **聚合信息应尽早沉淀到持久层**。用户在客户端「现查现配」不可靠（存在时序竞争与窗口限制）；在 agent-api 落库时聚合透传后，前端展示链路自然简化且可测试。
