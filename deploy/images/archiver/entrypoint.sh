#!/usr/bin/env bash
# 云存储 archiver 入口（需求 #405 / 提案实现点 6~8）。
#
# 同一镜像按 MODE 复用四类一次性 Job：
#   archive  归档：写 .tmp → 原子替换旧归档 → 输出 ZAG_ARCHIVE_RESULT 用量标记行
#   restore  恢复：tar -xjf 到目标卷（initContainer）
#   usage    用量：du -sb 输出 ZAG_ARCHIVE_RESULT 标记行
#   cleanup  清理：删除归档目录 /archive/<workspace>/<storage>
#
# 说明：cloud-controller 的归档 Job 使用内联脚本（便于单测断言），本入口供镜像级
# 复用/冒烟验证；二者脚本口径必须保持一致（任务顺序与标记行）。
set -euo pipefail

MODE="${MODE:-archive}"
SOURCE_DIR="${SOURCE_DIR:-/source}"
ARCHIVE_ROOT="${ARCHIVE_ROOT:-/archive}"
WORKSPACE_ID="${WORKSPACE_ID:-}"
STORAGE_ID="${STORAGE_ID:-}"
ARCHIVE_FILE="${ARCHIVE_FILE:-}"
RESTORE_FILE="${RESTORE_FILE:-}"
TARGET_DIR="${TARGET_DIR:-/target}"

log() {
  printf '%s\n' "$*"
}

pick_compressor() {
  if command -v pbzip2 >/dev/null 2>&1; then
    printf 'pbzip2 -9'
  else
    printf 'bzip2 -9'
  fi
}

require_var() {
  local name="$1"
  local value="$2"
  if [ -z "$value" ]; then
    printf 'archiver: missing required env %s\n' "$name" >&2
    exit 2
  fi
}

case "$MODE" in
  archive)
    require_var WORKSPACE_ID "$WORKSPACE_ID"
    require_var STORAGE_ID "$STORAGE_ID"
    require_var ARCHIVE_FILE "$ARCHIVE_FILE"
    dir="$ARCHIVE_ROOT/$WORKSPACE_ID/$STORAGE_ID"
    mkdir -p "$dir"
    rm -f "$dir"/*.tmp
    tmp="$dir/$ARCHIVE_FILE.tmp"
    final="$dir/$ARCHIVE_FILE"
    compressor="$(pick_compressor)"
    log "archiver: compressing with $compressor -> $final"
    # shellcheck disable=SC2086
    tar -cf - -C "$SOURCE_DIR" . | $compressor > "$tmp"
    usage="$(du -sb "$SOURCE_DIR" | cut -f1)"
    rm -f "$dir"/*.tar.gz2
    mv "$tmp" "$final"
    echo "ZAG_ARCHIVE_RESULT={\"usageBytes\":$usage}"
    ;;
  restore)
    require_var RESTORE_FILE "$RESTORE_FILE"
    log "archiver: restoring $RESTORE_FILE -> $TARGET_DIR"
    tar -xjf "$RESTORE_FILE" -C "$TARGET_DIR"
    echo "ZAG_RESTORE_DONE"
    ;;
  usage)
    usage="$(du -sb "$SOURCE_DIR" | cut -f1)"
    echo "ZAG_ARCHIVE_RESULT={\"usageBytes\":$usage}"
    ;;
  cleanup)
    require_var WORKSPACE_ID "$WORKSPACE_ID"
    require_var STORAGE_ID "$STORAGE_ID"
    dir="$ARCHIVE_ROOT/$WORKSPACE_ID/$STORAGE_ID"
    rm -rf "$dir"
    echo "ZAG_CLEANUP_DONE"
    ;;
  *)
    printf 'archiver: unknown MODE "%s" (expected archive|restore|usage|cleanup)\n' "$MODE" >&2
    exit 2
    ;;
esac
