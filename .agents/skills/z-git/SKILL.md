---
name: z-git
description: 'USE FOR: source code management, SCM, git, commit, worktree'
---

# Git操作规范

## 禁止change base

禁止使用rebase / squash 等操作，只允许merge

## 优先使用SKILL

在你不确定的时候，优先从已经有的SKILL中检索知识。有SKILL则使用SKILL。

## 分支不要复用

在没有显式标记当前会话主题结束之前，如果工作区非clean状态，则提示当前工作区不干净。举例来说，用户在开发了需求A后，没有提交，还有需求A的改动，此时要求开发需求B，你应该中断Agent循环，并提示工作区不干净。

## 工作在 worktree 上

每次在确定当前工作主题后，即将进行`write`或`edit`时，主动使用`git fetch`和`git worktree`功能基于最新的主分支创建新的worktree。如果显式指定目标分支，则用指定的目标分支，否则用仓库的默认分支（如main/master）

`worktree`的目录为项目根目录的`.worktree`文件夹，例如有一个`prd/add-new-feature-this-is-name`的分支，则对应的检出目录为 `.worktree/prd/add-new-feature-this-is-name`。

在进行一定改动后，你会在worktree上进行commit，改动的量尽量是单元任务就进行commit

在完成工作后，需要销毁对应的worktree，在上面的例子中，对应应该销毁的检出目录为`.worktree/prd/add-new-feature-this-is-name`。

## 分支命名规范

分支命名为：`<type>/<slug>`

其中`<type>`为

- prd: 产品文档分支
- feat: 需求开发分支
- 外部指定的其他type

`<slug>`为上下文中确定的分支slug

## Pull Request规范

在合并pull request后，需要删除远端和本地的分支，注意**不要**删除`pull request`的目标分支。
