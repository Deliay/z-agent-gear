# 默认工作容器镜像（云Agent二期）
#
# 面向内网环境构建：Ubuntu 源 / nvm 安装脚本 / Node.js 发行包 / npm 源
# 全部走内网 Nexus 代理，**不回退公网**（nodejs.org、raw.githubusercontent.com、github.com 均不可达）。
# 构建与自验命令见同目录 `BUILD.md`（内网环境执行）。
#
# 瘦身口径（工作负载四期）：镜像只保留所有容器都需要的通用能力。Docker（CLI / 镜像代理 shim /
# dockerd 及其运行时依赖）与 .NET / Aspire 的安装均**不再预装**，全部下沉到对应的预制工作负载脚本
# 按需提供（见 docs/engineering/proposals/20261018-feat-workload-phase4.md）。Node.js 保留——它是
# 容器内 agent-gear 的运行基础。
#
# ACP 适配器口径：镜像**不再预装** Claude Code / Codex 的 ACP 适配器
# （`@agentclientprotocol/claude-agent-acp`、`@agentclientprotocol/codex-acp`）。如需使用，
# 由用户在目标主机自行全局安装；agent-controller 仍保留对二者的探测与启动能力。
#
# 构建期可覆盖的参数（均为内网地址，如不可达请通过 --build-arg 替换）：
#   UBUNTU_MIRROR       Ubuntu apt 代理源
#   GITHUB_RAW_PROXY    GitHub raw 代理根地址（nvm 安装脚本及其 nvm.sh/nvm-exec/bash_completion）
#   NVM_VERSION         nvm 版本（v0.40.8）
#   NVM_INSTALL_URL     nvm 安装脚本地址（默认即 GITHUB_RAW_PROXY/nvm-sh/nvm/v0.40.8/install.sh）
#   NODEJS_DIST_MIRROR  Node.js 发行包代理源（nvm 的 index.tab/SHASUMS/tarball 均取自此处）
#   NODE_VERSION        由 nvm 安装的 Node.js 主版本
#   NPM_REGISTRY        npm 代理源（构建期用于安装全局包，并以 ENV 固化到运行时供 Node.js 工作负载脚本读取）

FROM ubuntu:24.04

ARG UBUNTU_MIRROR=http://nexus.internal.fffdan.com/repository/ubuntu-proxy/
ARG GITHUB_RAW_PROXY=https://nexus.internal.fffdan.com/repository/github-raw-proxy
ARG NVM_VERSION=v0.40.8
# 等价于 ${GITHUB_RAW_PROXY}/nvm-sh/nvm/${NVM_VERSION}/install.sh
ARG NVM_INSTALL_URL=https://nexus.internal.fffdan.com/repository/github-raw-proxy/nvm-sh/nvm/v0.40.8/install.sh
ARG NODEJS_DIST_MIRROR=https://nexus.internal.fffdan.com/repository/node-proxy
ARG NODE_VERSION=22
ARG NPM_REGISTRY=https://nexus.internal.fffdan.com/repository/npm-proxy/
# .NET 由工作负载脚本经 apt 安装（不再依赖 dotnet-install.sh）。默认包名 dotnet10、默认执行 apt-get upgrade，
# 可在运行时用同名环境变量覆盖；如内网 Ubuntu 源不含 .NET 10，可用 DOTNET_APT_SOURCE/DOTNET_APT_KEY_URL
# 在构建期注入内部 Microsoft feed 代理（见下方「.NET apt 源」）。
ARG DOTNET_APT_PACKAGE=dotnet10
ARG DOTNET_APT_UPGRADE=1

ENV DEBIAN_FRONTEND=noninteractive

# 运行时环境变量：ARG 仅构建期可见，这里把 npm 源固化进镜像运行时，
# 供「Node.js」预制工作负载脚本（`REGISTRY="${NPM_REGISTRY:-...}"`）读取。
ENV NPM_REGISTRY=${NPM_REGISTRY}

# 运行时环境变量：.NET 预制工作负载脚本（apt 版）读取；默认 dotnet10 / 执行 apt-get upgrade。
# 可按内网源覆盖包名（DOTNET_APT_PACKAGE）或排障/提速时关闭 upgrade（DOTNET_APT_UPGRADE=0）。
ENV DOTNET_APT_PACKAGE=${DOTNET_APT_PACKAGE} \
    DOTNET_APT_UPGRADE=${DOTNET_APT_UPGRADE}

# .NET apt 源（可选）：若内网 Ubuntu 源不含 .NET 10 包，用 build-arg 注入内部 Microsoft feed 代理：
#   --build-arg DOTNET_APT_SOURCE=https://nexus.internal.fffdan.com/repository/dotnet-proxy/ubuntu/24.04/prod
#   --build-arg DOTNET_APT_KEY_URL=https://nexus.internal.fffdan.com/repository/dotnet-proxy/microsoft.asc
# 二者同时提供时追加到 apt 源列表；未提供则仅使用上方配置的内网 Ubuntu 源。
ARG DOTNET_APT_SOURCE=
ARG DOTNET_APT_KEY_URL=

# 1) 切换 Ubuntu 软件源到内网 mirror（24.04 为 deb822 格式）
RUN rm -f /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list \
 && printf 'Types: deb\nURIs: %s\nSuites: noble noble-updates noble-backports\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\nTypes: deb\nURIs: %s\nSuites: noble-security\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n' "$UBUNTU_MIRROR" "$UBUNTU_MIRROR" > /etc/apt/sources.list.d/ubuntu.sources

# 2) 基础工具链 + GitHub CLI + git（通用能力，不含任何 dockerd 运行时依赖）
#    注意：这里**不装** nodejs/npm，Node.js 与 npm 统一由 nvm 提供
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git gh procps sudo \
 && rm -rf /var/lib/apt/lists/*

# 2.1) 可选：注入 .NET 10 的 Microsoft feed 代理源（仅当内网 Ubuntu 源不含 dotnet10 包时）。
#      需要同时提供 DOTNET_APT_SOURCE 与 DOTNET_APT_KEY_URL，否则跳过（不阻断构建）。
#      放在基础工具安装之后：此处才有 curl/ca-certificates/gnupg。
RUN if [ -n "$DOTNET_APT_SOURCE" ] && [ -n "$DOTNET_APT_KEY_URL" ]; then \
      install -m 0755 -d /etc/apt/keyrings \
      && curl -fsSL "$DOTNET_APT_KEY_URL" -o /etc/apt/keyrings/microsoft.asc \
      && chmod a+r /etc/apt/keyrings/microsoft.asc \
      && printf 'deb [arch=%s signed-by=/etc/apt/keyrings/microsoft.asc] %s noble main\n' \
           "$(dpkg --print-architecture)" "$DOTNET_APT_SOURCE" \
           > /etc/apt/sources.list.d/dotnet.list; \
    else \
      echo "DOTNET_APT_SOURCE/DOTNET_APT_KEY_URL not set; using the configured Ubuntu mirror for dotnet10"; \
    fi

# 3) worker 用户（uid/gid 1000，home /home/worker）与免密 sudo
#    - 移除基础镜像自带的 ubuntu 用户（uid 1000），避免与 worker 冲突
#    - PID 1 保持 root；agent-gear / npm / node 以 worker 身份运行（setpriv 降权）
RUN userdel -r ubuntu 2>/dev/null || true \
 && groupadd -g 1000 worker 2>/dev/null || true \
 && useradd -m -s /bin/bash -u 1000 -g worker worker \
 && printf 'worker ALL=(ALL:ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/90-worker \
 && chmod 0440 /etc/sudoers.d/90-worker \
 && printf '%s\n' \
      'export NVM_DIR="$HOME/.nvm"' \
      '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' \
      '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"' \
      > /etc/profile.d/nvm.sh

# 4) per-user nvm / Node.js / npm：全部装在 worker 的 home 下（root 环境没有 nodejs）
#    - nvm 安装脚本、Node.js 发行包、npm 源全部走内网代理（不回退公网）
#    - USER worker 层安装后 nvm 由 worker 拥有；current 软链供 WORKER_PATH 使用
ENV NVM_DIR=/home/worker/.nvm \
    NVM_NODEJS_ORG_MIRROR="$NODEJS_DIST_MIRROR" \
    NVM_SYMLINK_CURRENT=true
USER worker
RUN mkdir -p "$NVM_DIR" \
 && METHOD=script \
    PROFILE=/dev/null \
    NVM_INSTALL_URL="$NVM_INSTALL_URL" \
    NVM_SOURCE="$GITHUB_RAW_PROXY/nvm-sh/nvm/$NVM_VERSION/install.sh" \
    NVM_NODEJS_ORG_MIRROR="$NVM_NODEJS_ORG_MIRROR" \
    curl -o- "$NVM_INSTALL_URL" | bash \
 && . "$NVM_DIR/nvm.sh" \
 && nvm install --default "$NODE_VERSION" \
 && nvm alias default "$NODE_VERSION" \
 && ln -sfn "$(dirname "$(dirname "$(nvm which default)")")" "$NVM_DIR/current" \
 && npm config set registry "$NPM_REGISTRY"
# 镜像唯一预装的 npm 全局包：agent-gear。
# 不预装 Claude Code / Codex 的 ACP 适配器（claude-agent-acp、codex-acp）。
RUN . "$NVM_DIR/nvm.sh" \
 && npm install -g agent-gear@2.12.x \
 && npm cache clean --force \
 && node -v && npm -v && agent-gear --version
USER root
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 5) 默认启动命令即回连 cloud-controller（参数取自注入的环境变量）
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
