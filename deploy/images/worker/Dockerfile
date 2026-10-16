# 默认工作容器镜像（云Agent二期）
#
# 面向内网环境构建：Ubuntu 源 / nvm 安装脚本 / Node.js 发行包 / npm 源 / docker 镜像拉取
# 全部走内网 Nexus/Harbor 代理，**不回退公网**（nodejs.org、raw.githubusercontent.com、github.com 均不可达）。
# 构建与自验命令见同目录 `BUILD.md`（内网环境执行）。
#
# 构建期可覆盖的参数（均为内网地址，如不可达请通过 --build-arg 替换）：
#   UBUNTU_MIRROR       Ubuntu apt 代理源
#   GITHUB_RAW_PROXY    GitHub raw 代理根地址（nvm 安装脚本及其 nvm.sh/nvm-exec/bash_completion）
#   NVM_VERSION         nvm 版本（v0.40.8）
#   NVM_INSTALL_URL     nvm 安装脚本地址（默认即 GITHUB_RAW_PROXY/nvm-sh/nvm/v0.40.8/install.sh）
#   NODEJS_DIST_MIRROR  Node.js 发行包代理源（nvm 的 index.tab/SHASUMS/tarball 均取自此处）
#   NODE_VERSION        由 nvm 安装的 Node.js 主版本
#   NPM_REGISTRY        npm 代理源
#   DOCKER_APT_URL      Docker CE apt 源（含 buildx/containerd 包）

FROM ubuntu:24.04

ARG UBUNTU_MIRROR=http://nexus.internal.fffdan.com/repository/ubuntu-proxy/
ARG GITHUB_RAW_PROXY=https://nexus.internal.fffdan.com/repository/github-raw-proxy
ARG NVM_VERSION=v0.40.8
# 等价于 ${GITHUB_RAW_PROXY}/nvm-sh/nvm/${NVM_VERSION}/install.sh
ARG NVM_INSTALL_URL=https://nexus.internal.fffdan.com/repository/github-raw-proxy/nvm-sh/nvm/v0.40.8/install.sh
ARG NODEJS_DIST_MIRROR=https://nexus.internal.fffdan.com/repository/node-proxy
ARG NODE_VERSION=22
ARG NPM_REGISTRY=https://nexus.internal.fffdan.com/repository/npm-proxy/
ARG DOCKER_APT_URL=https://mirrors.ustc.edu.cn/docker-ce/linux/ubuntu/

ENV DEBIAN_FRONTEND=noninteractive

# 1) 切换 Ubuntu 软件源到内网 mirror（24.04 为 deb822 格式）
RUN rm -f /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list \
 && printf 'Types: deb\nURIs: %s\nSuites: noble noble-updates noble-backports\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\nTypes: deb\nURIs: %s\nSuites: noble-security\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n' "$UBUNTU_MIRROR" "$UBUNTU_MIRROR" > /etc/apt/sources.list.d/ubuntu.sources

# 2) 基础工具链 + GitHub CLI + git + 容器内 Docker 运行时依赖
#    注意：这里**不装** nodejs/npm，Node.js 与 npm 统一由 nvm 提供
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git gh \
      iptables iproute2 procps sudo \
      fuse-overlayfs libseccomp2 conntrack \
 && rm -rf /var/lib/apt/lists/*

# 3) 用 nvm 安装 Node.js / npm（替代系统包管理器提供的 node/npm）
#    - 安装脚本取自内网 GitHub raw 代理；脚本内硬编码的 raw.githubusercontent.com
#      被改写为同一代理地址，保证 nvm.sh / nvm-exec / bash_completion 都只走内网
#    - METHOD=script 强制脚本安装方式，避免回退到 `git clone https://github.com/nvm-sh/nvm.git`
#    - PROFILE=/dev/null 不让安装脚本写 profile，容器内改用 /etc/profile.d/nvm.sh
#    - NVM_NODEJS_ORG_MIRROR 指向内网 node-proxy：nvm 的 index.tab / SHASUMS256.txt /
#      node 发行包全部取自该地址，不会访问 nodejs.org（nvm v0.40.8 读取的变量名即为此）
ENV NVM_DIR=/usr/local/nvm
ENV NVM_NODEJS_ORG_MIRROR="$NODEJS_DIST_MIRROR"
RUN mkdir -p "$NVM_DIR" \
 && METHOD=script \
    PROFILE=/dev/null \
    NVM_SOURCE="https://nexus.internal.fffdan.com/repository/github-raw-proxy/nvm-sh/nvm/v0.40.8/install.sh" \
    NVM_NODEJS_ORG_MIRROR="$NODEJS_DIST_MIRROR" \
    curl -o- "$NVM_INSTALL_URL" | bash \
 && . "$NVM_DIR/nvm.sh" \
 && nvm install --default "$NODE_VERSION" \
 && nvm alias default "$NODE_VERSION" \
 && ln -sfn "$(dirname "$(dirname "$(nvm which default)")")" "$NVM_DIR/current" \
 && node -v && npm -v

# 3.1) 让 nvm 的 node/npm 进入 PATH（version 目录用 current 软链固定，运行时同样生效）
#      Node 镜像源固化为内网地址，运行时 `nvm install` 也不会回退公网
ENV PATH=$NVM_DIR/current/bin:$PATH \
    NVM_NODEJS_ORG_MIRROR=$NODEJS_DIST_MIRROR \
    NVM_SYMLINK_CURRENT=true

# 3.2) 登录 shell 可用的 nvm 初始化片段（bash_completion 缺失时自动跳过）
RUN printf '%s\n' \
      'export NVM_DIR="/usr/local/nvm"' \
      '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' \
      '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"' \
      > /etc/profile.d/nvm.sh

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
 && npm cache clean --force

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 6) 默认启动命令即回连 cloud-controller（参数取自注入的环境变量）
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
