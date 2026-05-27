---
description: ACP Server Windows 平台拉起实现计划
type: Permanent
---

# ACP Server Windows 平台拉起 - 实现计划

**关联提案**: `20260527-fix-acp-server-windows-launch.md`
**创建日期**: 2026-05-27
**feat-branch**: `fix/acp-server-windows-launch`

## 任务列表

### Task 1: `resolveCommand()` 平台感知改造

**文件**: `packages/agent-controller/src/acp/spawner.ts:82-93`

#### 改动内容

将原 `resolveCommand()` 拆分为平台感知的两条路径：

```typescript
import { platform } from 'os';

private resolveCommand(): string {
  const sep = this.command.includes('\\') || this.command.includes('/');
  if (sep) return this.command;

  if (platform() === 'win32') {
    return this.resolveWindowsCommand();
  }
  return this.resolveUnixCommand();
}

private resolveWindowsCommand(): string {
  // Windows: use `where` instead of `which`
  try {
    const result = execFileSync('where', [this.command], {
      encoding: 'utf8', timeout: 1000
    });
    const firstMatch = result.trim().split('\n')[0]?.trim();
    if (firstMatch) return firstMatch;
  } catch { /* not found via where */ }

  // Check with PATHEXT extensions
  const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';');
  for (const ext of pathext) {
    const candidate = this.command + ext.toLowerCase();
    if (existsSync(candidate)) return candidate;
  }

  return this.command;
}

private resolveUnixCommand(): string {
  const candidates = [
    this.command,
    `/usr/bin/${this.command}`,
    `/usr/local/bin/${this.command}`,
  ];
  for (const cmd of candidates) {
    try {
      const result = execFileSync('which', [cmd], {
        encoding: 'utf8', timeout: 1000
      });
      if (result.trim()) return result.trim();
    } catch { /* try next */ }
    if (existsSync(cmd)) return cmd;
  }
  return this.command;
}
```

#### 验证标准

- `resolveCommand()` 在 `platform() === 'win32'` 时调用 `where` 而非 `which`
- `resolveCommand()` 在 Unix 时保持原行为
- 路径含分隔符时直接返回，不走检测

---

### Task 2: `start()` 增加 `shell: true` 参数

**文件**: `packages/agent-controller/src/acp/spawner.ts:29-36`

#### 改动内容

```typescript
start(): void {
  const cmd = this.resolveCommand();
  console.log(`Starting ACP server ${cmd}`);
  mkdirSync(this.cwd, { recursive: true });

  const spawnOptions: SpawnOptions = {
    cwd: this.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  };

  if (platform() === 'win32') {
    spawnOptions.shell = true;
  }

  this.process = spawn(cmd, this.args, spawnOptions);
  // ...rest unchanged
}
```

需要导入 `SpawnOptions` 类型：
```typescript
import { spawn, execFileSync, type ChildProcess, type SpawnOptions } from 'child_process';
```

#### 验证标准

- `platform() === 'win32'` 时 `spawnOptions` 包含 `{ shell: true }`
- Unix 时 `spawnOptions` 不包含 `shell`
- `cmd` 使用 `resolveCommand()` 的返回值

---

### Task 3: `stop()` 信号处理适配

**文件**: `packages/agent-controller/src/acp/spawner.ts:67-75`

#### 改动内容

```typescript
stop(): void {
  if (!this.process) return;

  if (platform() === 'win32') {
    this.process.kill();  // TerminateProcess
    setTimeout(() => {
      if (this.process) {
        this.process.kill();  // force kill
      }
    }, 5000);
  } else {
    this.process.kill('SIGTERM');
    setTimeout(() => {
      if (this.process) {
        this.process.kill('SIGKILL');
      }
    }, 5000);
  }
}
```

#### 验证标准

- `platform() === 'win32'` 时调用 `kill()` 无信号参数
- Unix 时保持 `kill('SIGTERM')` → 5s → `kill('SIGKILL')`
- 不会在 Windows 上抛出 `EINVAL`

---

### Task 4: 更新测试

**文件**: `packages/agent-controller/tests/acp-spawner.test.ts`

#### 改动内容

当前测试文件（149 行）需要补充：

1. **`resolveCommand()` Windows 路径测试** — mock `platform()` 返回 `'win32'`，验证调用 `where` 而非 `which`，不尝试 Unix 路径
2. **`stop()` Windows 路径测试** — mock `platform()` 返回 `'win32'`，验证 `kill()` 无信号参数
3. **`start()` Windows 路径测试** — mock `platform()` 返回 `'win32'`，验证 `spawn` 被调用时参数包含 `{ shell: true }`

#### 关键 mock 策略

- 使用 `vi.mock('os', ...)` 或 `vi.spyOn(os, 'platform')` 来 mock `platform()`
- 对 `execFileSync` 的 mock 需区分 `which` 和 `where` 调用

---

### Task 5: 读取当前测试文件以确认 mock 方式

在编写 Task 4 之前，先读取 `packages/agent-controller/tests/acp-spawner.test.ts`，了解现有 mock 风格和测试框架使用方式，确保新增测试与现有风格一致。

---

## 依赖关系

```
Task 5（读测试） → Task 4（写测试）
Task 1/2/3 无先后依赖，可并行
```

## 验收 check-list

- [ ] Task 1: `resolveCommand()` Windows 路径使用 `where`
- [ ] Task 1: `resolveCommand()` Unix 路径保持原行为
- [ ] Task 2: Windows 上 `spawn` 带 `{ shell: true }`
- [ ] Task 2: Unix 上 `spawn` 无 `shell`
- [ ] Task 3: Windows 上 `kill()` 无信号参数
- [ ] Task 3: Unix 上保持 SIGTERM → SIGKILL
- [ ] Task 4: 新增测试覆盖 Windows 路径
- [ ] Task 4: 既有测试全部通过
