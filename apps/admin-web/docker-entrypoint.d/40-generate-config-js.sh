#!/bin/sh
# 容器启动时按 ADMIN_API_URL 生成 /usr/share/nginx/html/config.js，
# 供前端 window.__ADMIN_CONFIG__.apiUrl 运行时读取（见 src/lib/api-base.ts）。
# 未设置 ADMIN_API_URL 时生成空配置，前端回落到构建期 VITE_ADMIN_API_URL / 同源兜底。
#
# 安全：ADMIN_API_URL 会被拼进 JS 字符串字面量，若含引号/反斜杠/换行等即可注入任意
# 脚本（config.js 同源加载执行 → 持久化 XSS）。这里先做白名单形态校验（非法值拒绝启动），
# 再对写入值做 JSON 转义作为纵深防御。
set -eu

# 允许通过 CONFIG_FILE 覆盖输出路径（便于测试；容器内使用 nginx 站点目录）。
CONFIG_FILE="${CONFIG_FILE:-/usr/share/nginx/html/config.js}"

if [ -n "${ADMIN_API_URL:-}" ]; then
  case "$ADMIN_API_URL" in
    http://* | https://*) ;;
    *)
      echo "config: ADMIN_API_URL must start with http:// or https://" >&2
      exit 1
      ;;
  esac

  newline='
'
  case "$ADMIN_API_URL" in
    *"$newline"*)
      echo "config: ADMIN_API_URL must not contain newlines" >&2
      exit 1
      ;;
  esac

  # 白名单字符集之外仍有残留 → 非法（引号、反斜杠、空白、尖括号、反引号等一律拒绝）
  invalid=$(printf '%s' "$ADMIN_API_URL" | tr -d 'A-Za-z0-9._~:/?#@!$&()*+,;=%-')
  if [ -n "$invalid" ]; then
    echo "config: ADMIN_API_URL contains invalid characters" >&2
    exit 1
  fi

  escaped=$(printf '%s' "$ADMIN_API_URL" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  printf 'window.__ADMIN_CONFIG__ = { apiUrl: "%s" };\n' "$escaped" > "$CONFIG_FILE"
else
  printf 'window.__ADMIN_CONFIG__ = {};\n' > "$CONFIG_FILE"
fi
