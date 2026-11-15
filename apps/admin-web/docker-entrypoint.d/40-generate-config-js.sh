#!/bin/sh
# 容器启动时按 ADMIN_API_URL 生成 /usr/share/nginx/html/config.js，
# 供前端 window.__ADMIN_CONFIG__.apiUrl 运行时读取（见 src/lib/api-base.ts）。
# 同时按 AGENT_API_URL 注入 window.__ADMIN_CONFIG__.agentApiUrl（第三方登录跳转）。
# 未设置时前端回落到构建期 VITE_ADMIN_API_URL / VITE_AGENT_API_URL / 同源兜底。
#
# 安全：ADMIN_API_URL 会被拼进 JS 字符串字面量，若含引号/反斜杠/换行等即可注入任意
# 脚本（config.js 同源加载执行 → 持久化 XSS）。这里先做白名单形态校验（非法值拒绝启动），
# 再对写入值做 JSON 转义作为纵深防御。
set -eu

# 允许通过 CONFIG_FILE 覆盖输出路径（便于测试；容器内使用 nginx 站点目录）。
CONFIG_FILE="${CONFIG_FILE:-/usr/share/nginx/html/config.js}"

validate_url() {
  name="$1"
  value="$2"
  case "$value" in
    http://* | https://*) ;;
    *)
      echo "config: $name must start with http:// or https://" >&2
      exit 1
      ;;
  esac
  newline='
'
  case "$value" in
    *"$newline"*)
      echo "config: $name must not contain newlines" >&2
      exit 1
      ;;
  esac
  invalid=$(printf '%s' "$value" | tr -d 'A-Za-z0-9._~:/?#@!$&()*+,;=%-')
  if [ -n "$invalid" ]; then
    echo "config: $name contains invalid characters" >&2
    exit 1
  fi
}

ADMIN_PART=""
if [ -n "${ADMIN_API_URL:-}" ]; then
  validate_url ADMIN_API_URL "$ADMIN_API_URL"
  escaped=$(printf '%s' "$ADMIN_API_URL" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  ADMIN_PART="apiUrl: \"$escaped\""
fi

AGENT_PART=""
if [ -n "${AGENT_API_URL:-}" ]; then
  validate_url AGENT_API_URL "$AGENT_API_URL"
  escaped_agent=$(printf '%s' "$AGENT_API_URL" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  AGENT_PART="agentApiUrl: \"$escaped_agent\""
fi

if [ -n "$ADMIN_PART" ] && [ -n "$AGENT_PART" ]; then
  printf 'window.__ADMIN_CONFIG__ = { %s, %s };\n' "$ADMIN_PART" "$AGENT_PART" > "$CONFIG_FILE"
elif [ -n "$ADMIN_PART" ]; then
  printf 'window.__ADMIN_CONFIG__ = { %s };\n' "$ADMIN_PART" > "$CONFIG_FILE"
elif [ -n "$AGENT_PART" ]; then
  printf 'window.__ADMIN_CONFIG__ = { %s };\n' "$AGENT_PART" > "$CONFIG_FILE"
else
  printf 'window.__ADMIN_CONFIG__ = {};\n' > "$CONFIG_FILE"
fi
