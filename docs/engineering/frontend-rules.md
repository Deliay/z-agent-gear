# Frontend Development Rules

## Tech Stack

- **Framework**: React 19+ with TypeScript (strict mode)
- **Build Tool**: Vite
- **Styling**: Tailwind CSS v4 (with @tailwindcss/vite plugin)
- **State Management**: React Context / Zustand
- **GraphQL Client**: Apollo Client
- **Routing**: React Router v7
- **Testing**: Vitest + React Testing Library
- **Package Manager**: npm
- **Formatter**: Prettier

## Project Structure

```
apps/agent-web/
├── src/
│   ├── components/      # Reusable UI components
│   ├── pages/           # Page-level components
│   ├── hooks/           # Custom React hooks
│   ├── graphql/         # GraphQL queries/mutations/codegen
│   ├── stores/          # State management (Zustand stores)
│   ├── lib/             # Utility functions
│   ├── App.tsx          # Root app component
│   └── main.tsx         # Entry point
├── public/
├── vite.config.ts
├── tsconfig.json
└── package.json
```

## Component Conventions

- **Component files**: `PascalCase.tsx` (e.g., `AgentCard.tsx`)
- **Non-component files**: `camelCase.ts` (e.g., `useAgent.ts`)
- One component per file.
- Use functional components with hooks.

## Styling

- Use Tailwind utility classes primarily.
- Avoid custom CSS unless absolutely necessary.
- Use Tailwind's `@apply` for repeated patterns in component scope.

## GraphQL Client

- Use Apollo Client for GraphQL queries/mutations.
- Generate TypeScript types from GraphQL schema using GraphQL Code Generator.
