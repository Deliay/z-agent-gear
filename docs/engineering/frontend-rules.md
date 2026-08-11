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

## Styling Conventions

- **配色映射表要语义化而非颜色名**。命名颜色键（`purple`/`blue`/`yellow`/`gray`）名不副实、易腐化；改用语义键（`active`/`completed`/`failed`）表达意图，且保留旧键避免破坏存量调用方。

## 布局与溢出

- **flex 行内容器默认不收缩，窄容器必溢出**。`<pre>` 默认不换行、flex 子项默认 `min-width: auto`，把完整视图嵌入窄面板（Dialog/Sheet）前必须系统性检查 `whitespace-pre-wrap break-all` / `min-w-0 truncate` / `shrink-0` 三件套；E2E 用 `scrollWidth - clientWidth ≤ 1` 直接断言「无横向溢出」。
- **CSS Grid 隐式列是横向溢出的隐形炸弹**。`grid` 不显式声明 `grid-cols-1` 时，移动端单列是 `auto` 轨按 max-content 伸展，任何子内容超宽都会撑破整页；显式 `grid-cols-1`（`minmax(0,1fr)`）+ 子级 `min-w-0` + 文本 `wrap-anywhere` 三件套缺一不可，且要用「超长无空格内容 + 全展开 + 窄视口」极端场景做 E2E 溢出断言。
- **Tailwind `prose` 类不是免费午餐**。未装 `@tailwindcss/typography` 时 `prose` 完全不生效，markdown 渲染的表格/链接/行内 code 必须在 components 覆写里自行约束断行与滚动；`break-words` 不缩 min-content，根治不可断长词要用 `break-all`。

## 数据刷新与表单输入

- **轮询刷新 + 条件渲染 = 输入必丢**。活数据页面的表单输入要么受控于不受条件渲染影响的层级，要么持久化草稿（localStorage 按键隔离即可，成本极低）。
- **Apollo Client v4 轮询陷阱**。`notifyOnNetworkStatusChange` 默认 `true`，`if (loading) return <Spinner/>` 写法会在每次轮询卸载整页；加载分支必须写成 `loading && !data`。「保留草稿」与「不打断输入」是两个问题：前者靠持久化，后者靠不卸载（焦点/IME 断言才能抓到）。
