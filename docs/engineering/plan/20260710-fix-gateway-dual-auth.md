---
description: 网关代理双模式认证 - 实现计划
type: Permanent
---

# 网关代理双模式认证 - 实现计划

**关联 Proposal**: `proposals/20260710-fix-gateway-dual-auth.md`
**创建日期**: 2026-07-10

## 实现顺序

```
Phase 1: 后端 cookie-parser + 认证逻辑
  └── Phase 2: 前端 cookie 写入/清除
       └── Phase 3: Contract 更新
            └── Phase 4: 测试覆盖
```

---

## Phase 1: 后端 cookie-parser + 认证逻辑

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/package.json` | 修改 | 添加 `cookie-parser` 依赖 |
| `servers/agent-api/src/index.ts` | 修改 | 注册 `cookieParser()` 中间件 |
| `servers/agent-api/src/routes/gateway-proxy.ts` | 修改 | `authenticateExpressUser` 添加 cookie fallback |

### 1.1 安装依赖

```
npm install cookie-parser
npm install --save-dev @types/cookie-parser
```

### 1.2 servers/agent-api/src/index.ts 变更

在 `compressionMiddleware()` 注册之后，路由注册之前，添加 `cookieParser()`：

```typescript
import cookieParser from 'cookie-parser';
// ... existing imports

app.use(cors({ origin: config.corsOrigin }));
app.use(compressionMiddleware());
app.use(cookieParser());
```

### 1.3 servers/agent-api/src/routes/gateway-proxy.ts 变更

修改 `authenticateExpressUser`（`gateway-proxy.ts:22-36`）：

```typescript
async function authenticateExpressUser(req: Request): Promise<{ id: string; username: string } | null> {
  let token: string | undefined;

  // 模式 1: Authorization header
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    token = header.slice(7);
  }

  // 模式 2: Cookie fallback
  if (!token) {
    token = req.cookies?.token;
  }

  if (!token) return null;

  try {
    const payload = verifyToken(token);
    const user = await User.findById(payload.userId).select('username');
    if (!user) return null;
    return { id: user._id.toString(), username: user.username };
  } catch {
    return null;
  }
}
```

### 启动 & 验证

```bash
# agent-api 目录下
npm run build    # TypeScript 编译通过
curl http://localhost:4000/api/gateway/{id}/{name}/path                          # 应返回 401
curl -H "Cookie: token=<JWT>" http://localhost:4000/api/gateway/{id}/{name}/path # 应正常代理
curl -H "Authorization: Bearer <JWT>" http://localhost:4000/api/gateway/{id}/{name}/path # 仍正常
```

---

## Phase 2: 前端 cookie 写入/清除

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/stores/AuthProvider.tsx` | 修改 | 登录/登出时同步操作 cookie |

### 2.1 apps/agent-web/src/stores/AuthProvider.tsx 变更

当前 `AuthProvider` 中 `login` 写 localStorage，`logout` 清空：

```typescript
// Line 18-25
const login = useCallback((newToken: string, user: User) => {
  localStorage.setItem('auth_token', newToken);
  setToken(newToken);
  setUser(user);
}, []);

const logout = useCallback(() => {
  localStorage.removeItem('auth_token');
  setToken(null);
  setUser(null);
}, []);
```

新增 cookie 写入/清除逻辑：

```typescript
const COOKIE_OPTIONS = 'path=/; max-age=86400; SameSite=Lax';

function setCookie(value: string) {
  document.cookie = `token=${value}; ${COOKIE_OPTIONS}`;
}

function clearCookie() {
  document.cookie = 'token=; path=/; max-age=0';
}

const login = useCallback((newToken: string, user: User) => {
  localStorage.setItem('auth_token', newToken);
  setCookie(newToken);           // 新增: 写 cookie
  setToken(newToken);
  setUser(user);
}, []);

const logout = useCallback(() => {
  localStorage.removeItem('auth_token');
  clearCookie();                 // 新增: 清 cookie
  setToken(null);
  setUser(null);
}, []);
```

### 启动 & 验证

```bash
# 前端通过 Aspire 自动启动
# 登录后检查浏览器 Application > Cookies 中是否存在 token
# 访问网关 URL 应自动携带 cookie，不再返回 401
```

---

## Phase 3: Contract 更新

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/gateway-proxy.openapi.yaml` | 修改 | 补充 cookie 认证方式说明 |

### 3.1 contracts/gateway-proxy.openapi.yaml 变更

在 `security` 和 `securitySchemes` 中补充 cookie 认证说明：

```yaml
security:
  - bearerAuth: []
  - cookieAuth: []        # 新增

components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
    cookieAuth:            # 新增
      type: apiKey
      in: cookie
      name: token
```

同时在 `description` 中说明认证优先级。

---

## Phase 4: 测试覆盖

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `servers/agent-api/src/routes/gateway-proxy.test.ts` | 新增 | 双模式认证单元测试 |

### 4.1 servers/agent-api/src/routes/gateway-proxy.test.ts

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/auth.js', () => ({
  verifyToken: vi.fn(),
}));

vi.mock('../models/user.js', () => ({
  User: {
    findById: vi.fn(),
  },
}));

import { verifyToken } from '../services/auth.js';
import { User } from '../models/user.js';

// 导入 authenticateExpressUser（需先将其从 gateway-proxy.ts 导出）
// 或通过 supertest 测试完整路由

describe('authenticateExpressUser', () => {
  it('should authenticate via Authorization header');
  it('should authenticate via Cookie token');
  it('should prefer header over cookie when both present');
  it('should return null when neither header nor cookie provided');
  it('should return null when token is invalid');
  it('should return null when user not found');
});
```

### 启动 & 验证

```bash
# agent-api 目录下
npm run test -- src/routes/gateway-proxy.test.ts
```

---

## 命令速查

| 命令 | 工作目录 | 说明 |
|------|---------|------|
| `npm install cookie-parser && npm install --save-dev @types/cookie-parser` | `servers/agent-api` | 安装依赖 |
| `npm run build` | `servers/agent-api` | TypeScript 编译 |
| `npm run test -- src/routes/gateway-proxy.test.ts` | `servers/agent-api` | 运行网关测试 |
| `aspire start` | 根目录 | 启动全部服务 |

---

## 验收 Checklist

- [ ] **Phase 1**: `cookieParser()` 注册后编译通过
- [ ] **Phase 1**: `authenticateExpressUser` 支持 header 和 cookie 双模式
- [ ] **Phase 1**: 手动 curl 验证 cookie 认证正常、header 认证兼容
- [ ] **Phase 2**: 前端登录后 `token` cookie 自动写入
- [ ] **Phase 2**: 前端登出后 `token` cookie 自动清除
- [ ] **Phase 2**: 浏览器访问网关 URL 不返回 401
- [ ] **Phase 3**: OpenAPI 契约更新完成
- [ ] **Phase 4**: 所有单元测试通过
