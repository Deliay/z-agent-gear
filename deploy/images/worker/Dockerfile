# 默认工作容器镜像（云Agent二期）
#
# 面向内网环境构建：Ubuntu 源 / npm 源 / docker 镜像拉取均走内网 Nexus/Harbor 代理。
# 构建与自验命令见同目录 `BUILD.md`（内网环境执行）。
#
# 构建期可覆盖的参数（均为内网地址，如不可达请通过 --build-arg 替换）：
#   UBUNTU_MIRROR    Ubuntu apt 代理源
#   NPM_REGISTRY     npm 代理源
#   DOCKER_APT_URL   Docker CE apt 源（含 buildx/containerd 包）
#   NODE_SOURCE_URL  NodeSource 源（默认不启用，使用 Ubuntu apt 的 nodejs）

FROM ubuntu:24.04

ARG UBUNTU_MIRROR=https://nexus.internal.fffdan.com/repository/ubuntu-proxy/
ARG NPM_REGISTRY=https://nexus.internal.fffdan.com/repository/npm-proxy/
ARG DOCKER_APT_URL=https://download.docker.com/linux/ubuntu
ARG NODE_SOURCE_URL=https://deb.nodesource.com/setup_22.x
ARG INSTALL_NODESOURCE=false

ENV DEBIAN_FRONTEND=noninteractive

# 1) 切换 Ubuntu 软件源到内网 mirror（24.04 为 deb822 格式）
RUN rm -f /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list \
 && printf 'Types: deb\nURIs: %s\nSuites: noble noble-updates noble-backports\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\nTypes: deb\nURIs: %s\nSuites: noble-security\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n' "$UBUNTU_MIRROR" "$UBUNTU_MIRROR" > /etc/apt/sources.list.d/ubuntu.sources

# 2) 基础工具链 + GitHub CLI + git + 容器内 Docker 运行时依赖
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git gh \
      iptables iproute2 procps sudo \
      fuse-overlayfs libseccomp2 conntrack \
      nodejs npm \
 && rm -rf /var/lib/apt/lists/*

# 3) 可选：NodeSource 安装更新版本 Node.js（默认走 apt 的 nodejs/npm）
RUN if [ "$INSTALL_NODESOURCE" = "true" ]; then \
      curl -fsSL "$NODE_SOURCE_URL" | bash - \
      && apt-get install -y --no-install-recommends nodejs \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# 4) Docker CE CLI + buildx + containerd（供容器内构建镜像）
RUN install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL "$DOCKER_APT_URL/gpg" -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] %s %s stable\n' "$(dpkg --print-architecture)" "$DOCKER_APT_URL" "$(. /etc/os-release && echo "$VERSION_CODENAME")" > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      docker-ce-cli docker-buildx-plugin containerd.io \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /usr/local/lib/docker/cli-plugins \
 && ln -sf /usr/libexec/docker/cli-plugins/docker-buildx /usr/local/lib/docker/cli-plugins/docker-buildx 2>/dev/null || true

# 5) npm 走内网代理并全局预装 Agent 工具链（PRD 功能点 3 全量 7 包）
RUN npm config set registry "$NPM_REGISTRY" \
 && npm install -g \
      agent-gear \
      @agentclientprotocol/claude-agent-acp \
      @agentclientprotocol/codex-acp \
      @opencode/cli \
      @openai/codex \
      @anthropic-ai/claude-code \
      @google/gemini-cli \
 && npm cache clean --force

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 6) 默认启动命令即回连 cloud-controller（参数取自注入的环境变量）
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
