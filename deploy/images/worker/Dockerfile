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

# 4) npm 走内网代理并全局预装 Agent 工具链（镜像 3 包；OpenCode 由 harness 工作负载安装）
#    镜像只预装 agent-gear + ACP 适配器（claude-agent-acp / codex-acp）：
#    - agent-gear 固定 2.9.x：`deepseek_harness` 的平台渠道模型注入与 `harness prepare` 分流自 2.9.0 起，
#      **不预装** `dsh`（DeepSeek Harness CLI 由「DeepSeek Harness（Harness）」工作负载安装）；
#      `kimi_code` 使用前登录闸门（`kimi login` stdio 判定）自 2.8.0 起，
#      **不预装** `kimi`（Kimi Code CLI 由「Kimi Code（Harness）」工作负载安装）；
#      opencode 配置模型上下文长度（`limit.context`，ZAG_MODEL_CONTEXT_LENGTHS）自 2.7.0 起；
#      `workload:run.githubAuth` 与云电脑 Github 凭据管理器自 2.6.0 起提供；
#      云电脑双连接与 `harness prepare` 自 2.5.0 起；工作负载「必须」短路（items[].required）自 2.4.0 起、
#      参数注入自 2.3.0 起；避免构建期取到不支持这些能力的旧版本（普通容器门禁仍为 >=2.2.0）。
#    - **不预装 `@opencode/cli`**：OpenCode 由「OpenCode（Harness）」工作负载的 init 脚本按
#      `OPENCODE_CLI_VERSION` 固定版本安装，并执行 `opencode --version` 硬校验 + `agent-gear harness prepare`
#      （见 servers/admin-api 迁移 005 与 BUILD.md）。
RUN npm config set registry "$NPM_REGISTRY" \
 && npm install -g \
      agent-gear@2.8.x \
 && npm cache clean --force

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 5) 默认启动命令即回连 cloud-controller（参数取自注入的环境变量）
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
