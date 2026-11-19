#!/bin/sh
# Caddy 官方镜像没有 nginx 的 /docker-entrypoint.d 钩子，这里保留同名目录约定：
# 先按文件名顺序执行 docker-entrypoint.d/*.sh（生成运行时 config.js），再启动 Caddy。
set -eu

for script in /docker-entrypoint.d/*.sh; do
  [ -e "$script" ] || continue
  echo "docker-entrypoint: running $script"
  sh "$script"
done

exec "$@"
