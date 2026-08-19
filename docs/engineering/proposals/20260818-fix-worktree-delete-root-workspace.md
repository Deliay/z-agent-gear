---
description: 删除 Worktree 误删根工作区（.git 丢失）修复方案——list 过滤主工作区 + deleteWorktree 根路径拒绝 + fs:remove-dir .git 目录兜底
type: Permanent
---

# 删除 Worktree 误删根工作区修复 - 技术方案

**功能名称**: 删除 Worktree 误删根工作区（.git 丢失）修复
**关联验收报告**: docs/engineering/acceptance/20260817-session-lifecycle-and-worktree-acceptance-report.md
**关联方案**: docs/engineering/proposals/20260817-fix-session-lifecycle-worktree-acceptance.md、docs/engineering/proposals/20260818-fix-delete-session-acp-process-leak.md
**feat-branch**: `integration`（PR #173 → release）
**创建日期**: 2026-08-18
**作者**: ZeroAsh

## 1. 概述

### 1.1 背景

人工复验发现：**在侧边栏删除 worktree 时把根工作区（仓库本体）也删除了，本地 .git 丢失**——严重数据丢失。

### 1.2 根因分析

完整链路三层失守：

1. **agent-api `worktreeService.list()` 不过滤主工作区**（`servers/agent-api/src/services/worktree.ts:64-67`）：controller 端 `git worktree list --porcelain`（`worktree-handler.ts:77`）的**首条记录就是主工作区（仓库根 = `workspace.path`）**，被原样并入 `worktreeMap` → 前端侧边栏把根目录展示为一个可删除的 worktree 分组。
2. **`deleteWorktree` 校验以 `list()` 结果为准**（`worktree.ts:147-152`）：根路径在列表里，校验通过；随后 `git worktree remove --force <根>` 被 git 拒绝（main working tree）→ 进入 `fs:remove-dir` 兜底（`worktree.ts:200-227`）。
3. **controller 端白名单被会话 cwd 污染**（`packages/agent-controller/src/socketio-client.ts:323`）：`acp:start`/`acp:resume` 无条件 `fsHandler.registerAllowedPath(data.cwd)`，而**普通会话的 cwd 就是仓库根** → 根目录早已进入 `fs:remove-dir` 白名单 → `rmSync(根, recursive)` 执行，仓库与 `.git` 全毁。

### 1.3 目标

- 主工作区不再出现在 worktree 列表/删除入口。
- 即使上层失守，任何路径都不允许通过本系统删除 git 主工作区（纵深防御）。
- 按 TDD 修复，单测/API/E2E 全绿。

### 1.4 范围

| 子项目 | 修复 |
|--------|------|
| servers/agent-api | ① `list()` 过滤主工作区（`path === workspace.path` 归一化比较）；② `deleteWorktree` 显式拒绝根路径（`BAD_USER_INPUT`），先于 list 校验 |
| packages/agent-controller | ③ `fs-handler.removeDir` 拒绝删除「`.git` 为目录」的路径（git 主工作区特征；linked worktree 的 `.git` 是普通文件，不受影响） |

## 2. 修复方案

### 2.1 agent-api（servers/agent-api/src/services/worktree.ts）

- `list()`：并入 `gitWorktrees` 时跳过 `path.normalize(wt.path) === path.normalize(workspace.path)` 的条目（主工作区不是可管理 worktree，不展示、不进入 `deleteWorktree` 的合法路径集）。
- `deleteWorktree()`：在 list 校验之前，显式拒绝 `path.normalize(worktreePath) === path.normalize(workspace.path)`，抛 `BAD_USER_INPUT`（防御，即使 list 过滤被绕过也不会对根路径发出任何 git/fs 命令）。

### 2.2 agent-controller（packages/agent-controller/src/fs-handler.ts）

- `removeDir` 增加主工作区保护：目标路径下 `.git` 存在且为**目录** → 拒绝（`statSync(<path>/.git).isDirectory()`）。git 主工作区的 `.git` 是目录；linked worktree 的 `.git` 是指向主仓库 gitdir 的普通文件——该特征精确区分二者，worktree 正常删除不受影响。
- 此条与路径无关，覆盖所有调用方（`fs:remove-dir` 兜底、未来新增入口），是最后一道防线。

### 2.3 测试（TDD）

| 层 | 用例 |
|----|------|
| agent-api `worktree.test.ts` | ① list：git worktree 列表含主工作区 + worktree → 结果只含 worktree；② deleteWorktree：worktreePath === workspace.path → `BAD_USER_INPUT`，不发布 git:worktree:remove / fs:remove-dir |
| agent-controller `tests/fs-handler.test.ts`（新建，真实 fs） | ③ 已注册路径含 `.git` 目录 → removeDir 拒绝且目录仍在；④ 已注册路径含 `.git` 文件（模拟 linked worktree）→ removeDir 成功删除 |

## 3. 验证

1. 红：4 个用例先失败。
2. 绿：实施修复，agent-api / agent-controller 单测全绿，build 通过。
3. 回归：controller-api / agent-web 单测；Aspire 环境下 tests/api、tests/e2e 全量。
4. 人工复验路径：git workspace 侧边栏不再展示根目录条目；删除任一 worktree 不影响仓库本体与 `.git`。
