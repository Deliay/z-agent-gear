---
description: 本地控制器配置页 - 实现计划
type: Permanent
---

# 本地控制器配置页 - 实现计划

**关联 Proposal**: `proposals/20260522-feat-local-controller-config-page.md`
**创建日期**: 2026-05-22

## 实现顺序

```
Phase 1: agent-api refreshAcpCapabilities + checkedAt
  └── Phase 2: controller-api acp:cache:invalidate handler
       └── Phase 3: 前端 SettingsPage 改造 + ControllerConfigPage
            └── Phase 4: 前端 WorkspaceSection（从 Dialog 迁移）
                 └── Phase 5: 前端 HarnessToolsSection（新）
                      └── Phase 6: 前端 Sidebar 控制器配置入口
```

Phase 1+2 可独立并行，Phase 3+4+6 可独立并行，Phase 5 依赖 Phase 1 的 GraphQL schema。

---

## Phase 1: agent-api refreshAcpCapabilities + checkedAt

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/graphql/schemas/session.ts` | 修改 | 新增 `refreshAcpCapabilities` mutation 定义 |
| `servers/agent-api/src/graphql/resolvers/session.ts` | 修改 | 新增 `refreshAcpCapabilities` resolver |
| `servers/agent-api/src/services/session.ts` | 修改 | 新增 `refreshAcpCapabilities()` 方法；修改 `getAcpCapabilities()` 返回 `checkedAt` |
| `contracts/agent-session.graphql` | ✅ 已完成 | `AcpCapability` + `checkedAt`，`Mutation` + `refreshAcpCapabilities` |

### schema 变更 (`schemas/session.ts`)

```graphql
extend type Mutation {
  refreshAcpCapabilities(controllerId: ID!): [AcpCapability!]!
}
```

注意：`AcpCapability` 类型中 `checkedAt` 字段已在 schema 中定义，确认存在。

### resolver 变更 (`resolvers/session.ts`)

```typescript
refreshAcpCapabilities: async (
  _parent: unknown,
  args: { controllerId: string },
  context: AuthContext,
) => {
  if (!context.currentUser) throw new GraphQLError('Not authenticated');
  return sessionService.refreshAcpCapabilities(args.controllerId, context.currentUser.id);
},
```

### service 变更 (`services/session.ts`)

```typescript
async refreshAcpCapabilities(controllerId: string, userId: string): Promise<Record<string, unknown>[]> {
  // 1. 验证控制器归属
  const controller = await Controller.findOne({ _id: controllerId, userId }).lean();
  if (!controller) throw new Error('Controller not found');

  const redis = getRedisClient();

  // 2. 删除 Redis 缓存
  await redis.del(`acp:capability:${controllerId}`);

  // 3. 通知 controller-api 清内存缓存
  await redis.publish('session:command', JSON.stringify({
    type: 'acp:cache:invalidate',
    controllerId,
  }));

  // 4. 触发重新探测并返回结果（复用 getAcpCapabilities 的轮询逻辑）
  return this.getAcpCapabilities(controllerId, userId);
}
```

`getAcpCapabilities` 需要修改返回结构，从 Redis 缓存 JSON 中提取 `checkedAt` 拼接到每个能力项中：

```typescript
async getAcpCapabilities(controllerId: string, userId: string): Promise<Record<string, unknown>[]> {
  // ... 验证逻辑不变 ...

  const redis = getRedisClient();
  const cached = await redis.get(`acp:capability:${controllerId}`);
  if (cached) {
    const parsed = JSON.parse(cached);
    return parsed.servers.map((s: Record<string, unknown>) => ({
      ...s,
      checkedAt: parsed.checkedAt || null,
    }));
  }

  // ... 原有的轮询逻辑 ...
  // 轮询成功后同样拼接 checkedAt
  const result = await redis.get(`acp:capability:${controllerId}`);
  if (result) {
    const parsed = JSON.parse(result);
    return parsed.servers.map((s: Record<string, unknown>) => ({
      ...s,
      checkedAt: parsed.checkedAt || null,
    }));
  }

  return [];
}
```

### 启动 & 验证

```bash
cd servers/agent-api
npm run build
npm run test
```

---

## Phase 2: controller-api acp:cache:invalidate handler

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/controller-api/src/services/session-command.ts` | 修改 | 新增 `acp:cache:invalidate` 命令 case |
| `contracts/agent-session-websocket.md` | ✅ 已完成 | 新增 `acp:cache:invalidate` 文档 |

### session-command.ts 变更

在 `subscribe()` 的 command.type 分支中新增：

```typescript
} else if (command.type === 'acp:cache:invalidate' && command.controllerId) {
  acpCapabilityDetector.invalidateCache(command.controllerId);
}
```

依赖：`acpCapabilityDetector` 已导入，`invalidateCache()` 方法已存在。

### 启动 & 验证

```bash
cd servers/controller-api
npm run build
npm run test
```

---

## Phase 3: 前端 SettingsPage 改造 + ControllerConfigPage

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/pages/SettingsPage.tsx` | 修改 | 导航重命名 + 二级页面状态 + URL query param |
| `apps/agent-web/src/pages/ControllerConfigPage.tsx` | **新建** | 控制器配置二级页面 |
| `apps/agent-web/src/components/settings/ControllerListSection.tsx` | 修改 | 「管理工作区」改为跳转配置页；新增 `onNavigateToConfig` 回调 |

### SettingsPage.tsx 变更

```typescript
import { useSearchParams } from 'react-router-dom';
import ControllerConfigPage from '@/pages/ControllerConfigPage';

export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const controllerId = searchParams.get('controllerId');
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  // 如果 URL 中有 controllerId 参数，渲染控制器配置页
  if (controllerId) {
    const controllerName = '...'; // 可从全局状态或 prop 获取
    return (
      <ControllerConfigPage
        controllerId={controllerId}
        onBack={() => {
          setSearchParams({}); // 清除 query param 回到设置主页
        }}
        onNavigateToSettings={() => {
          // 切换到设置页指定 section
        }}
      />
    );
  }

  // 原有渲染...
}
```

左侧导航变更：

```tsx
<div className="pt-2">
  <div className="px-3 pb-1 text-xs font-medium text-muted-foreground">
    本地控制器          {/* 从「控制器」改为「本地控制器」 */}
  </div>
  <button onClick={() => scrollTo('controller-section')}>
    控制器管理
  </button>
</div>
```

### ControllerConfigPage.tsx（新建）

```tsx
interface ControllerConfigPageProps {
  controllerId: string;
  onBack: () => void;
}

export default function ControllerConfigPage({ controllerId, onBack }: ControllerConfigPageProps) {
  // 获取控制器信息
  const { data: controllerData } = useQuery<GetControllersQuery>(GET_CONTROLLERS);
  const controller = controllerData?.controllers.find(c => c.id === controllerId);

  const [activeSection, setActiveSection] = useState<'workspace' | 'harness'>('workspace');

  return (
    <div className="grid h-full grid-cols-[200px_1fr]">
      <nav className="border-r p-4">
        {/* 顶部：返回按钮 + 控制器名称 */}
        <button onClick={onBack}>← 返回</button>
        <div className="mt-2 flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${controller?.status === 'online' ? 'bg-green-500' : 'bg-gray-400'}`} />
          <span className="font-medium">{controller?.name || '加载中...'}</span>
        </div>

        {/* Section 导航 */}
        <div className="mt-6 space-y-1">
          <button onClick={() => setActiveSection('workspace')}
            className={`w-full rounded-md px-3 py-2 text-sm text-left ${activeSection === 'workspace' ? 'bg-accent' : 'hover:bg-accent'}`}>
            工作区
          </button>
          <button onClick={() => setActiveSection('harness')}
            className={`w-full rounded-md px-3 py-2 text-sm text-left ${activeSection === 'harness' ? 'bg-accent' : 'hover:bg-accent'}`}>
            可用 Harness 工具
          </button>
        </div>
      </nav>

      <div className="overflow-y-auto p-8">
        {activeSection === 'workspace' ? (
          <WorkspaceSection controllerId={controllerId} controllerOnline={controller?.status === 'online'} />
        ) : (
          <HarnessToolsSection controllerId={controllerId} />
        )}
      </div>
    </div>
  );
}
```

### ControllerListSection.tsx 变更

```tsx
interface ControllerListSectionProps {
  onNavigateToConfig?: (controllerId: string) => void;
  onNavigateToConfigSection?: (controllerId: string, section: 'workspace') => void;
}

// 使用 props 替代本地的 workspaceTarget 状态
// 「管理工作区」按钮改为 onNavigateToConfigSection(ctrl.id, 'workspace')
// 新增「配置」图标按钮 onNavigateToConfig(ctrl.id)
```

actions 区域变更：

```tsx
<div className="flex gap-1">
  <Button variant="ghost" size="sm" onClick={() => onNavigateToConfig?.(ctrl.id)}>
    配置
  </Button>
  <Button variant="ghost" size="sm" onClick={() => onNavigateToConfigSection?.(ctrl.id, 'workspace')}>
    管理工作区
  </Button>
  <Button variant="ghost" size="sm" onClick={() => setRenameTarget(...)}>
    重命名
  </Button>
  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmUnbind(...)}>
    解绑
  </Button>
</div>
```

SettingsPage 的 `scrollTo` 需要对应修改：点击「管理工作区」时设置 URL `?controllerId=xxx` 而不是打开 Dialog。

### 启动 & 验证

```bash
cd apps/agent-web
npm run build
npm run test
```

---

## Phase 4: 前端 WorkspaceSection（从 Dialog 迁移）

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/settings/WorkspaceSection.tsx` | **新建** | 从 `WorkspaceManagerDialog` 提取的逻辑，去除 Dialog 包裹 |
| `apps/agent-web/src/components/settings/WorkspaceManagerDialog.tsx` | 修改 | 保留为兼容入口，内部调用 WorkspaceSection 或标记废弃 |
| `apps/agent-web/src/components/settings/NewSessionDialog.tsx` | 如有「管理工作区」链接指向 Dialog，需更新指向 ControllerConfigPage |

### WorkspaceSection.tsx 设计

```tsx
interface WorkspaceSectionProps {
  controllerId: string;
  controllerOnline?: boolean;
}

export default function WorkspaceSection({ controllerId, controllerOnline = false }: WorkspaceSectionProps) {
  // 完全从 WorkspaceManagerDialog 迁移，移除 Dialog/Footer 包裹
  // 保持：添加（showPicker）、删除、清空、toggle 功能
  // 保持：目录选择器 DirectoryPicker 的集成
  // 保持：「历史会话」按钮 + HistorySessionDialog
  // 恢复：拖拽排序功能（原有 Dialog 中已规划但未实现？提案中保留此项）
}
```

核心变更：
- 移除 `<Dialog>` `<DialogContent>` `<DialogHeader>` `<DialogFooter>` 等外层
- 移除 `onClose` prop
- 移除「关闭」按钮
- 内容直接渲染在页面中
- 标题改为 `h2` 标签而非 `DialogTitle`

### WorkspaceManagerDialog.tsx 兼容方案

保持文件存在，内部修改为：

```tsx
export default function WorkspaceManagerDialog({ controllerId, controllerName, controllerOnline, onClose }: WorkspaceManagerDialogProps) {
  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>管理工作区</DialogTitle>
        </DialogHeader>
        <WorkspaceSection controllerId={controllerId} controllerOnline={controllerOnline} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

但在当前版本中，`WorkspaceManagerDialog` 将不再被 `ControllerListSection` 直接使用（改为跳转配置页），此兼容层仅在外部引用处保留。

### 启动 & 验证

```bash
cd apps/agent-web
npm run build
npm run test
```

---

## Phase 5: 前端 HarnessToolsSection

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/settings/HarnessToolsSection.tsx` | **新建** | Harness 工具列表 Section |
| `apps/agent-web/src/graphql/queries.ts` | 修改 | 如有必要新增带 checkedAt 的 query |
| `apps/agent-web/src/graphql/mutations.ts` | 修改 | 新增 `REFRESH_ACP_CAPABILITIES` mutation |
| `apps/agent-web/src/graphql/types.ts` | 修改 | 新增 `RefreshAcpCapabilitiesMutation` 类型 |

### HarnessToolsSection.tsx 设计

```tsx
interface HarnessToolsSectionProps {
  controllerId: string;
}

export default function HarnessToolsSection({ controllerId }: HarnessToolsSectionProps) {
  const { data, loading, refetch } = useQuery<GetAcpCapabilitiesQuery>(GET_ACP_CAPABILITIES, {
    variables: { controllerId },
    fetchPolicy: 'cache-and-network',
  });

  const [refresh, { loading: refreshing }] = useMutation<RefreshAcpCapabilitiesMutation>(REFRESH_ACP_CAPABILITIES);

  const capabilities = data?.acpCapabilities ?? [];
  // 提取 checkedAt （所有项相同，取第一个）
  const checkedAt = capabilities[0]?.checkedAt ?? null;

  const handleRefresh = async () => {
    await refresh({ variables: { controllerId } });
    refetch();
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">可用 Harness 工具</h2>
        <Button size="sm" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? '刷新中...' : '刷新'}
        </Button>
      </div>

      {checkedAt && (
        <p className="text-sm text-muted-foreground mb-4">
          上次检测：{new Date(checkedAt).toLocaleString()}
        </p>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground">加载中...</div>
      ) : capabilities.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          当前控制器未检测到可用工具
        </div>
      ) : (
        <div className="space-y-2">
          {capabilities.map((cap) => (
            <div key={cap.type} className="flex items-center gap-3 rounded-lg border p-4">
              <div className={`h-2 w-2 rounded-full ${cap.available ? 'bg-green-500' : 'bg-gray-400'}`} />
              <div className="flex-1">
                <div className="font-medium">{cap.type}</div>
                {cap.version && (
                  <div className="text-sm text-muted-foreground">v{cap.version}</div>
                )}
              </div>
              <span className={`rounded px-1.5 py-0.5 text-xs ${
                cap.available ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'
              }`}>
                {cap.available ? '可用' : '不可用'}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
```

### GraphQL 变更

`mutations.ts` 新增：

```typescript
export const REFRESH_ACP_CAPABILITIES = gql`
  mutation RefreshAcpCapabilities($controllerId: ID!) {
    refreshAcpCapabilities(controllerId: $controllerId) {
      type
      available
      version
      checkedAt
    }
  }
`
```

`types.ts` 新增：

```typescript
export interface RefreshAcpCapabilitiesMutation {
  refreshAcpCapabilities: AcpCapabilityData[]
}
```

### 启动 & 验证

```bash
cd apps/agent-web
npm run build
npm run test
```

---

## Phase 6: 前端 Sidebar 控制器配置入口

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/Sidebar.tsx` | 修改 | 控制器节点增加齿轮图标 |

### Sidebar.tsx 变更

在控制器节点的 `<button>` 内，名称 `<span>` 和展开箭头之间增加齿轮图标：

```tsx
<button
  type="button"
  className={`flex w-full items-center gap-2 rounded px-3 py-2 text-sm transition-colors hover:bg-gray-800 ${isOffline ? 'opacity-50' : ''}`}
  onClick={() => toggleController(controller.id)}
>
  <span className={`h-2 w-2 shrink-0 rounded-full ${controller.status === 'online' ? 'bg-green-500' : 'bg-gray-500'}`} />
  <span className="flex-1 truncate text-left font-medium">
    {controller.name || controller.hostname}
  </span>
  {/* 配置按钮 - 阻止点击冒泡 */}
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation();
      navigate(`/settings?controllerId=${controller.id}`);
    }}
    className="rounded p-0.5 text-gray-400 hover:text-white"
    title="控制器配置"
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  </button>
  <span className="text-xs text-gray-400">
    {isExpanded ? '▼' : '▶'}
  </span>
</button>
```

关键点：
- 齿轮图标使用与 SettingsPage 底部相同的 SVG path
- 使用 `e.stopPropagation()` 防止点击齿轮时触发展开/折叠
- 导航到 `/settings?controllerId=${controller.id}`

### 启动 & 验证

```bash
cd apps/agent-web
npm run build
npm run test
```

---

## 测试计划

### 单元测试

| 阶段 | 测试文件 | 新增/修改 | 说明 |
|------|----------|-----------|------|
| Phase 1 | `servers/agent-api/src/services/session.test.ts` | 修改 | 添加 `refreshAcpCapabilities` 测试 |
| Phase 1 | `tests/api/src/agent-api/session.test.ts` | 修改 | 添加 `refreshAcpCapabilities` API 测试 |
| Phase 3 | `apps/agent-web/src/pages/__tests__/ControllerConfigPage.test.tsx` | 新建 | 配置页面渲染和导航 |
| Phase 4 | `apps/agent-web/src/components/settings/__tests__/WorkspaceSection.test.tsx` | 新建 | 工作区 Section 功能 |
| Phase 5 | `apps/agent-web/src/components/settings/__tests__/HarnessToolsSection.test.tsx` | 新建 | Harness 工具列表渲染和刷新 |

### E2E 测试

| 场景 | 步骤 |
|------|------|
| 侧边栏→配置页 | 点击侧边栏齿轮 → 进入配置页 → 验证双栏布局 |
| 工作区管理 | 添加/删除/清空工作区 → 验证 CRUD 正常 |
| Harness 工具刷新 | 进入配置页 → 点击刷新 → 验证列表更新 |
| 设置页快捷入口 | 设置页→本地控制器→控制器管理→点击「配置」→进入配置页 |
| 返回 | 配置页→返回→回到设置页控制器列表 |

---

## 命令速查

| 命令 | 工作目录 | 说明 |
|------|---------|------|
| `npm run build` | 各子项目 | TypeScript 编译 |
| `npm run test` | 各子项目 | 运行单元测试 |
| `npm run test -- --run` | `tests/api` | 运行集成 API 测试 |
| `aspire start` | 根目录 | 启动全部服务 |

---

## 验收 Checklist

- [ ] **Phase 1**: `refreshAcpCapabilities` mutation 可用，`checkedAt` 字段返回正确
- [ ] **Phase 2**: controller-api 收到 `acp:cache:invalidate` 后清内存缓存
- [ ] **Phase 3**: 设置页导航「控制器」→「本地控制器」
- [ ] **Phase 3**: 控制器列表「配置」按钮进入双栏配置页面
- [ ] **Phase 3**: 配置页顶部显示控制器名称和在线状态，「返回」按钮回到列表
- [ ] **Phase 4**: 工作区 Section 功能完整（添加/删除/清空/toggle/历史会话）
- [ ] **Phase 5**: Harness 工具 Section 显示 ACP Server 列表
- [ ] **Phase 5**: 刷新按钮工作正常，loading 状态正确
- [ ] **Phase 5**: 空状态显示提示文案
- [ ] **Phase 5**: 上次检测时间正确展示
- [ ] **Phase 6**: 侧边栏控制器节点齿轮图标可点击跳转
- [ ] **Phase 6**: 点击齿轮不触发展开/折叠
