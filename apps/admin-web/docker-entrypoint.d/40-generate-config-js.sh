#!/bin/sh
# 容器启动时按 ADMIN_API_URL 生成 /usr/share/nginx/html/config.js，
# 供前端 window.__ADMIN_CONFIG__.apiUrl 运行时读取（见 src/lib/api-base.ts）。
# 未设置 ADMIN_API_URL 时生成空配置，前端回落到构建期 VITE_ADMIN_API_URL / 同源兜底。
set -e

CONFIG_FILE="/usr/share/nginx/html/config.js"

if [ -n "${ADMIN_API_URL}" ]; then
  printf 'window.__ADMIN_CONFIG__ = { apiUrl: "%s" };\n' "${ADMIN_API_URL}" > "$CONFIG_FILE"
else
  printf 'window.__ADMIN_CONFIG__ = {};\n' > "$CONFIG_FILE"
fi
