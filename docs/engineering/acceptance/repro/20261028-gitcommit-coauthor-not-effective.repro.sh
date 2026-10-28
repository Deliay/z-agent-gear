#!/usr/bin/env bash
# 最小复现：云容器 Commit 「Co-Author」设置未生效
#
# 结论（本脚本第 1 部分可 100% 稳定复现）：
#   托管身份只写全局 include.path（~/.zag/commit-identity.gitconfig），
#   而 git 的配置优先级为 仓库本地 > worktree > 全局 > 系统。
#   一旦仓库本地存在 user.name/user.email（本问题中由 Agent 在 commit 失败后自行写入 bot 身份），
#   全局托管身份与人/机器人 Co-Author 的预期都会被本地配置覆盖。
#
# 第 2 部分为现场取证探针（需要云容器环境变量 ZAG_AGENT_API_ENDPOINT / ZAG_CONTROLLER_ID /
# ZAG_HOST_KEY；只读，不修改任何配置）。
#
# 用法：
#   bash docs/engineering/acceptance/repro/20261028-gitcommit-coauthor-not-effective.repro.sh
#   LIVE=1 bash ...   # 额外执行现场取证
set -euo pipefail

section() { printf '\n### %s\n' "$*"; }

# ---------------------------------------------------------------------------
# 第 1 部分：本地身份覆盖托管全局身份（离线、确定性）
# ---------------------------------------------------------------------------
ORIG_PWD="$PWD"
REAL_HOME="$HOME"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"
mkdir -p "$HOME/.zag/git-hooks" "$HOME/repo"

# 模拟 agent-gear CommitIdentity.apply('co_author', {name: Deliay, coAuthor: z-agent-bot})
cat > "$HOME/.zag/commit-identity.gitconfig" <<'EOF'
[user]
	name = Deliay
	email = 12345+Deliay@users.noreply.github.com
EOF
cat > "$HOME/.zag/git-hooks/prepare-commit-msg" <<'EOF'
#!/bin/sh
MSG="$1"
[ -n "$MSG" ] || exit 0
TRAILER='Co-authored-by: z-agent-bot[bot] <301571485+z-agent-bot[bot]@users.noreply.github.com>'
grep -qF "$TRAILER" "$MSG" 2>/dev/null && exit 0
git interpret-trailers --in-place --trailer "$TRAILER" "$MSG" 2>/dev/null \
  || printf '\n%s\n' "$TRAILER" >> "$MSG"
exit 0
EOF
chmod +x "$HOME/.zag/git-hooks/prepare-commit-msg"
git config --global include.path "$HOME/.zag/commit-identity.gitconfig"
git config --global core.hooksPath "$HOME/.zag/git-hooks"

cd "$HOME/repo"
git init -q

section "场景 A：仓库本地写入了 bot 身份（当前线上现场）"
git config user.name 'z-agent-bot[bot]'
git config user.email '301571485+z-agent-bot[bot]@users.noreply.github.com'
git config --show-origin user.name
echo hello > a.txt && git add a.txt && git commit -qm 'with local bot identity'
git log -1 --format='author: %an <%ae>%nbody: %b'

section "场景 B：移除仓库本地身份后（期望的 Co-Author 结果）"
git config --unset user.name
git config --unset user.email
git config --show-origin user.name
echo world >> a.txt && git add a.txt && git commit -qm 'without local identity'
git log -1 --format='author: %an <%ae>%nbody: %b'

# ---------------------------------------------------------------------------
# 第 2 部分：现场取证（只读）
# ---------------------------------------------------------------------------
if [ "${LIVE:-0}" = "1" ]; then
  section "现场：内部端点返回"
  curl -sS -m 10 -X POST \
    "$ZAG_AGENT_API_ENDPOINT/internal/cloud-hosts/$ZAG_CONTROLLER_ID/commit-identity" \
    -H "Authorization: Bearer $ZAG_HOST_KEY"
  echo

  section "现场：托管文件 / 全局配置"
  ls -la "$REAL_HOME/.zag/commit-identity.gitconfig" "$REAL_HOME/.zag/git-hooks" 2>&1 || true
  HOME="$REAL_HOME" git config --global --get-all include.path || true
  HOME="$REAL_HOME" git config --global --get core.hooksPath || true

  section "现场：仓库内实际生效身份（真实 HOME）"
  HOME="$REAL_HOME" git -C "$ORIG_PWD" config --show-origin --get-all user.name
  HOME="$REAL_HOME" git -C "$ORIG_PWD" config --show-origin --get-all user.email

  section "现场：最近提交的作者 / trailer"
  git -C "$ORIG_PWD" log -5 --format='%h author=%an <%ae> trailers=[%(trailers:key=Co-authored-by,valueonly)]'
fi
