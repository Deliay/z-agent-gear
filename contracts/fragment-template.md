# Fragment 模板渲染契约（语义契约）

> 需求 #449 / PRD `docs/product/draft/20261113-fragment-template-custom-tools.md` /
> 提案 `docs/engineering/proposals/20261113-feat-fragment-template-custom-tools.md` §3.1。
>
> 本文件是 Fragment 模型与渲染语义的**唯一事实源**：后端 `servers/agent-api/src/services/fragment-render.ts`
> 与前端 `apps/agent-web/src/lib/fragment-editor.ts` 各自实现序列化/解析纯函数，均以本契约为准，
> 两侧单测以同一 fixture 做 round-trip 互锁（计划 D7）。

## 1. 数据模型

```typescript
type FragmentType = 'Plain' | 'Valut' | 'Parameter';

/** 可扩展集合：新增格式必须先改本契约（本期仅 Generic / Json / Uri）。 */
type FragmentFormat = 'Generic' | 'Json' | 'Uri';

interface Fragment {
  type: FragmentType;
  value: string;
  format: FragmentFormat;
}

interface RenderContext {
  userId: string;
  tenantId: string;
  workspaceId: string;
  params: Record<string, string>;
}

type ValutResolver = (
  key: string,
  ctx: { workspaceId: string },
) => Promise<string | null>;

renderFragments(
  fragments: Fragment[],
  context: RenderContext,
  resolveValut: ValutResolver,
): Promise<string>;
```

- `Fragment` 是 GraphQL（`contracts/custom-tool.graphql` 的 `Fragment` 类型）、存储
  （`customtools.prompt` / `customtools.http.*`）与前端编辑器共享的唯一形状，字段名与枚举值**大小写敏感**。
- `renderFragments` 只允许在服务端调用；前端编辑器**不求值**，只展示引用名。

## 2. 渲染规则

逐片段按顺序解析并拼接：

| type | 取值 | format | 输出 |
|------|------|--------|------|
| `Plain` | 直接取 `value` | 恒按 `Generic` 处理（`format` 对 Plain 无意义） | `value` 原样；空串（`''`）省略 |
| `Valut` | 以 `value` 为 key，在 `context.workspaceId` 的 **manual** namespace 取值 | `Generic` | 取到的明文原样 |
| `Valut` | 同上 | `Json` | `JSON.stringify(resolved)`（结果带引号并转义） |
| `Valut` | 同上 | `Uri` | `encodeURIComponent(resolved)` |
| `Parameter` | `context.params[value]` | `Generic` | 参数值原样 |
| `Parameter` | 同上 | `Json` | `JSON.stringify(resolved)` |
| `Parameter` | 同上 | `Uri` | `encodeURIComponent(resolved)` |

错误口径（逐字，服务端白名单）：

- `Valut` 片段取不到值（key 不存在 / 非 manual / 跨工作区）→ 抛 `valut key not found: <key>`；
- `Parameter` 片段在 `context.params` 中缺失（`undefined`）→ 抛 `missing parameter: <key>`；
- 渲染上限超限 → 抛 `fragment template too large`。

> 取值后的格式管线**统一负责编码**：`Json` / `Uri` 只发生一次；http 组装层（query / header / body
> 拼接）**不得二次编码**（计划 D8）。
>
> `Json` 模式输出自带引号与转义：模板中不要再用引号包裹 Json 片段，否则会产生双重引号。

## 3. 上限

| 维度 | 上限 | 说明 |
|------|------|------|
| `fragments.length` | 200 | 渲染前校验 |
| 单片段 `value` 长度 | 4096 | 渲染前校验 |
| 渲染结果总长 | 65536 | 渲染前按 `value` 累计上限 + 渲染后结果长度双重约束 |

任一维度超限抛 `fragment template too large`（不区分维度，不向外泄露内部细节）。

## 4. 序列化（前端编辑器 ↔ Fragment[]）

编辑器以「节点序列」为内部模型，`fragmentsToNodes` / `nodesToFragments` 双向往返：

1. **Plain 相邻合并**：连续 `type='Plain'` 片段在解析为节点时合并为一个文本节点；
   由节点序列转回 Fragment[] 时相邻文本合并为**单个** Plain 片段。
2. **空 Plain 省略**：`value === ''` 的 Plain 片段在 `nodesToFragments` 输出中一律省略
   （纯引用模板只包含 Valut/Parameter 片段）。
3. 引用片段（Valut / Parameter）为**原子节点**：不可在编辑器内拆分或就地编辑其 `value`，
   只能整体删除；其 `format` 由创建时的编辑器模式决定（Plain 恒 `Generic`）。
4. round-trip 不变量：对任意合法 Fragment[]，`fragmentsToNodes` → `nodesToFragments`
   与「先做规则 1/2 归一的结果」等价（幂等）。

## 5. 安全红线

- **求值仅在服务端**：`renderFragments` 是唯一求值点；编辑器任何状态不请求、不展示密钥值。
- **明文不出服务端**：Valut 解密值只在 `renderFragments` 调用栈内存中出现；唯一合法出口是
  MCP 工具调用结果（prompt 渲染串 / http 请求产物）。任何日志、接口响应、页面均不得包含明文。
- **仅 manual namespace**：Valut 片段取值与 `#` 补全名单都限定 `manual`；服务托管
  （`service-*`）密钥名视为取不到（`valut key not found`）。
- **日志白名单**：渲染链路只记 `sessionId` / `toolId` / `name` / `status` / `reason` / `errName`
  等白名单字段，不记片段内容、渲染中间值、请求/响应正文与 headers。

## 6. 错误与 MCP 映射

- 渲染失败在 MCP `tools/call` 中返回 `isError: true` 的文本结果，文案限上述白名单；
  **不回传任何密钥片段或渲染中间值**。
- `tools/call` 参数缺失（`Parameter` 所需参数未传入）在渲染前由 MCP 层以
  `INVALID_PARAMS` 拒绝并列出缺失 key；渲染期缺失同上仍抛 `missing parameter: <key>`（防御式）。
