# archiver 镜像（云存储归档 / 恢复 / 用量 / 清理，需求 #405）
#
# 独立于 worker 镜像：只包含 tar / bzip2 压缩链与 coreutils，以 root 运行
# （需要读取 uid 1000 worker 的文件并写入归档 PVC）。
#
# 内网构建：Ubuntu apt 源走内网 Nexus 代理（--build-arg UBUNTU_MIRROR 可覆盖）。
# 构建与自验命令见同目录 BUILD.md。

FROM ubuntu:24.04

ARG UBUNTU_MIRROR=http://nexus.internal.fffdan.com/repository/ubuntu-proxy/

ENV DEBIAN_FRONTEND=noninteractive

# bzip2 为 pbzip2 缺席时的运行期回退（entrypoint 自动选择 compressor）。
RUN set -eux; \
    if [ -n "${UBUNTU_MIRROR}" ]; then \
      sed -i "s|http://archive.ubuntu.com/ubuntu/|${UBUNTU_MIRROR}|g; s|http://security.ubuntu.com/ubuntu/|${UBUNTU_MIRROR}|g" /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null || true; \
      sed -i "s|http://archive.ubuntu.com/ubuntu/|${UBUNTU_MIRROR}|g; s|http://security.ubuntu.com/ubuntu/|${UBUNTU_MIRROR}|g" /etc/apt/sources.list 2>/dev/null || true; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      coreutils \
      tar \
      pbzip2 \
      bzip2; \
    rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/archiver-entrypoint.sh
RUN chmod 0755 /usr/local/bin/archiver-entrypoint.sh

# 归档 Job 内以 root 读取源卷（worker uid 1000）并写归档卷。
USER root

ENTRYPOINT ["/usr/local/bin/archiver-entrypoint.sh"]
