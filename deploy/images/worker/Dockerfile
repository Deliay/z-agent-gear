# 默认工作容器镜像（云Agent二期）
#
# 构建期走官方公网源（Ubuntu archive / raw.githubusercontent.com / nodejs.org / registry.npmjs.org），
# 使镜像可在 GitHub Actions 等公网环境构建；依赖全部安装完成后，再把镜像内 apt / nvm(Node.js) / npm
# 源替换为内网 Nexus 代理，供容器运行时与预制工作负载使用。
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
# 构建期可覆盖的参数：
#   NVM_VERSION         nvm 版本（v0.40.8）
#   NVM_INSTALL_URL     nvm 安装脚本地址（默认官方 raw.githubusercontent.com）
#   NODE_VERSION        由 nvm 安装的 Node.js 主版本（默认 24）
#
# 运行期源（构建完成后写入镜像，均可通过同名 build-arg 覆盖）：
#   UBUNTU_MIRROR       apt 源（默认内网 Nexus ubuntu-proxy）
#   NODEJS_DIST_MIRROR  运行时 nvm 的 Node.js 发行包源（默认内网 Nexus node-proxy）
#   NPM_REGISTRY        npm/pnpm registry（默认内网 Nexus npm-proxy；以 ENV 固化供工作负载读取）

FROM ubuntu:24.04

ARG UBUNTU_MIRROR=http://nexus.internal.fffdan.com/repository/ubuntu-proxy/
ARG NODEJS_DIST_MIRROR=https://nexus.internal.fffdan.com/repository/node-proxy
ARG NVM_VERSION=v0.40.8
# 构建期使用官方安装脚本；镜像构建完成后 nvm 的 Node.js 源切换为 NODEJS_DIST_MIRROR。
ARG NVM_INSTALL_URL=https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh
ARG NODE_VERSION=24
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
# 二者同时提供时写入 apt 源列表（供运行时工作负载使用）；未提供则运行时仅使用 UBUNTU_MIRROR。
ARG DOTNET_APT_SOURCE=
ARG DOTNET_APT_KEY_URL=

# 1) 构建期使用官方 Ubuntu 源（基础镜像默认即是；显式重置避免上游镜像漂移）。
#    内网 apt 源在镜像构建完成后统一写入（见文件末尾「切换到内网源」）。
RUN rm -f /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list \
 && printf 'Types: deb\nURIs: %s\nSuites: noble noble-updates noble-backports\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\nTypes: deb\nURIs: %s\nSuites: noble-security\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n' \
      "http://archive.ubuntu.com/ubuntu/" "http://security.ubuntu.com/ubuntu/" \
      > /etc/apt/sources.list.d/ubuntu.sources

# 2) 基础工具链 + GitHub CLI + git（通用能力，不含任何 dockerd 运行时依赖）
#    注意：这里**不装** nodejs/npm，Node.js 与 npm 统一由 nvm 提供
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git gh procps sudo \
 && rm -rf /var/lib/apt/lists/*

# 2.1) 可选：写入 .NET 10 的 Microsoft feed 代理源（供运行时工作负载使用）。
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
      echo "DOTNET_APT_SOURCE/DOTNET_APT_KEY_URL not set; runtime will only use UBUNTU_MIRROR"; \
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
#    - 构建期走官方源（nvm 安装脚本 / nodejs.org），镜像完成后切换为内网 NODEJS_DIST_MIRROR
#    - USER worker 层安装后 nvm 由 worker 拥有；current 软链供 WORKER_PATH 使用
ENV NVM_DIR=/home/worker/.nvm \
    NVM_SYMLINK_CURRENT=true \
    PNPM_HOME=/home/worker/.local/share/pnpm \
    PATH=/home/worker/.local/share/pnpm/bin:/home/worker/.local/share/pnpm:$PATH
USER worker
RUN mkdir -p "$NVM_DIR" \
 && METHOD=script \
    PROFILE=/dev/null \
    NVM_INSTALL_URL="$NVM_INSTALL_URL" \
    NVM_SOURCE="https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" \
    curl -o- "$NVM_INSTALL_URL" | bash \
 && . "$NVM_DIR/nvm.sh" \
 && nvm install --default "$NODE_VERSION" \
 && nvm alias default "$NODE_VERSION" \
 && ln -sfn "$(dirname "$(dirname "$(nvm which default)")")" "$NVM_DIR/current"
# 4.1) 用 npm 自举 pnpm（npm 仅保留为 pnpm 引导通道），之后全局 CLI 统一用 pnpm 安装。
#      pnpm 12 的全局 bin 目录是 $PNPM_HOME/bin（不是 $PNPM_HOME），必须在 PATH 中，否则 `pnpm add -g` 直接报
#      ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH。版本固定在这里而不是顶部 ARG，避免改版本时整层缓存全失效。
# 镜像唯一预装的全局包：agent-gear。
# 不预装 Claude Code / Codex 的 ACP 适配器（claude-agent-acp、codex-acp）。
# 安装完成后才把 npm registry 切到内网（构建期使用官方 registry.npmjs.org）。
RUN . "$NVM_DIR/nvm.sh" \
 && npm install -g "pnpm@12.16.1" \
 && npm cache clean --force \
 && pnpm add -g agent-gear@2.15.x \
 && pnpm store prune \
 && npm config set registry "$NPM_REGISTRY" \
 && node -v && npm -v && pnpm -v && agent-gear --version
USER root
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 5) 安装全部完成后切换到内网源：apt / nvm Node.js（ENV 供运行时与工作负载使用）
RUN printf 'Types: deb\nURIs: %s\nSuites: noble noble-updates noble-backports\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\nTypes: deb\nURIs: %s\nSuites: noble-security\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n' \
      "$UBUNTU_MIRROR" "$UBUNTU_MIRROR" \
      > /etc/apt/sources.list.d/ubuntu.sources \
 && rm -rf /var/lib/apt/lists/*

ENV NVM_NODEJS_ORG_MIRROR="$NODEJS_DIST_MIRROR"

# 6) 默认启动命令即回连 cloud-controller（参数取自注入的环境变量）
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
