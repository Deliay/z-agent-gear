---
description: ACP Server 支持 MiMo Code / Kimi Code CLI - 实现计划
type: Permanent
---

# ACP Server 支持 MiMo Code / Kimi Code CLI - 实现计划

**关联 Proposal**: `proposals/20260721-feat-acp-mimo-kimi.md`
**创建日期**: 2026-07-21

## 实现顺序

```
Phase 1: Contract + 后端 enum 扩展
  └── Phase 2: agent-controller detector 扩展
       └── Phase 3: 前端标签映射
            └── Phase 4: 测试覆盖
```

---

## Phase 1: Contract + 后端 enum 扩展

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `contracts/agent-session.graphql` | 修改 | `enum AcpServerType` 增加 `mimo_code`、`kimi_code` |
| `servers/agent-api/src/graphql/schemas/session.ts` | 修改 | 同步 `enum AcpServerType` |
| `servers/agent-api/src/models/session.ts` | 修改 | Mongoose `enum` 数组增加两个新值 |
| `servers/controller-api/src/models/session.ts` | 修改 | Mongoose `enum` 数组增加两个新值 |

### contracts/agent-session.graphql 变更

```graphql
enum AcpServerType {
  opencode
  github_copilot
  claude_code
  gemini_cli
  codex
  mimo_code
  kimi_code
}
```

### servers/agent-api/src/models/session.ts 变更

```typescript
acpServerType: { type: String, enum: ['opencode', 'github_copilot', 'claude_code', 'gemini_cli', 'codex', 'mimo_code', 'kimi_code'], required: true },
```

### servers/controller-api/src/models/session.ts 变更

同上。

### 启动 & 验证

```bash
# agent-api 目录下
npm run build    # TypeScript 编译通过
npm run test     # 单元测试

# controller-api 目录下
npm run build    # TypeScript 编译通过
npm run test     # 单元测试
```

---

## Phase 2: agent-controller detector 扩展

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/src/acp/detector.ts` | 修改 | 新增 `detectMiMoCode()`、`detectKimiCode()`；`detect()` 并行检测；`getSpawnerConfig()` 新增两个 case |

### detector.ts 变更要点

- `detect()` 的 `Promise.all` 数组增加 `this.detectMiMoCode()`、`this.detectKimiCode()`
- 新增 `detectMiMoCode()`: 执行 `mimo --version`
- 新增 `detectKimiCode()`: 执行 `kimi --version`
- `getSpawnerConfig()` switch 新增:
  - `'mimo_code'` → `{ command: 'mimo', args: ['acp'] }`
  - `'kimi_code'` → `{ command: 'kimi', args: ['acp'] }`

### 无需改动的文件

- `spawner.ts` / `bridge.ts` / `sync-bridge.ts` — 已支持外部传入 spawner
- `socketio-client.ts` — 已通过 `createSpawner(serverType, ...)` 泛化

### 启动 & 验证

```bash
# agent-controller 目录下
npm run build    # TypeScript 编译
npm run test     # 单元测试
```

---

## Phase 3: 前端标签映射

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `apps/agent-web/src/components/session/SessionHeader.tsx` | 修改 | `acpServerTypeLabels` 新增 `mimo_code`、`kimi_code` |

### SessionHeader.tsx 变更

```typescript
const acpServerTypeLabels: Record<string, string> = {
  opencode: 'OpenCode',
  github_copilot: 'GitHub Copilot',
  claude_code: 'Claude Code',
  gemini_cli: 'Gemini CLI',
  codex: 'Codex',
  mimo_code: 'MiMo Code',
  kimi_code: 'Kimi Code',
};
```

### 启动 & 验证

```bash
# agent-web 目录下
npm run build    # TypeScript 编译
npm run test     # 单元测试
```

---

## Phase 4: 测试覆盖

### 文件修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/agent-controller/tests/acp-detector.test.ts` | 修改 | 新增两种 Server 的检测测试 + spawner config 测试 |
| `apps/agent-web/src/components/session/SessionHeader.test.tsx` | 修改 | 新增两种 Server 的标签展示测试（如存在） |

### detector.test.ts 测试要点

```typescript
describe('AcpDetector', () => {
  it('should detect mimo_code', async () => {
    vi.mocked(execAsync).mockResolvedValueOnce({ stdout: '0.1.0\n', stderr: '' });
    const result = await detector.detectMiMoCode();
    expect(result.type).toBe('mimo_code');
    expect(result.available).toBe(true);
    expect(result.version).toBe('0.1.0');
  });

  it('should detect kimi_code', async () => {
    vi.mocked(execAsync).mockResolvedValueOnce({ stdout: '1.0.0\n', stderr: '' });
    const result = await detector.detectKimiCode();
    expect(result.type).toBe('kimi_code');
    expect(result.available).toBe(true);
    expect(result.version).toBe('1.0.0');
  });

  it('should return getSpawnerConfig for mimo_code', () => {
    const config = detector.getSpawnerConfig('mimo_code');
    expect(config.command).toBe('mimo');
    expect(config.args).toEqual(['acp']);
  });

  it('should return getSpawnerConfig for kimi_code', () => {
    const config = detector.getSpawnerConfig('kimi_code');
    expect(config.command).toBe('kimi');
    expect(config.args).toEqual(['acp']);
  });
});
```

### 运行测试

```bash
# 各子项目目录下
npm run test     # 单元测试
```

---

## 命令速查

| 命令 | 工作目录 | 说明 |
|------|---------|------|
| `npm run build` | 各子项目 | TypeScript 编译 |
| `npm run test` | 各子项目 | 运行单元测试 |
| `aspire start` | 根目录 | 启动全部服务 |

---

## 验收 Checklist

- [ ] **Phase 1**: Contract + GraphQL schema + Mongoose model enum 编译通过
- [ ] **Phase 2**: `AcpDetector.detect()` 返回 7 个 Server 检测结果
- [ ] **Phase 2**: `getSpawnerConfig('mimo_code')` 返回 `{ command: 'mimo', args: ['acp'] }`
- [ ] **Phase 2**: `getSpawnerConfig('kimi_code')` 返回 `{ command: 'kimi', args: ['acp'] }`
- [ ] **Phase 3**: SessionHeader 显示 "MiMo Code" 标签
- [ ] **Phase 3**: SessionHeader 显示 "Kimi Code" 标签
- [ ] **Phase 4**: 所有测试通过
- [ ] **兼容性**: 已有 Session（五种已有 Server）不受任何影响
