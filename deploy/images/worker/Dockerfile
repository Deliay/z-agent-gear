# 默认工作容器镜像（云Agent二期）
#
# 构建期只访问官方公网 Ubuntu archive（基础镜像默认即是），因此可在 GitHub Actions 等公网环境构建。
# 主目录工具链（Node.js / pnpm / agent-gear 等）**不在构建期安装**：云存储会把 PVC 挂到
# /home/worker 并遮蔽镜像内主目录，改由入口 entrypoint 启动时以 worker 用户从内网源幂等安装
# （bootstrap_home / ensure_pnpm / update_agent_gear），保证首次启动与挂载云存储后的环境一致。
# 依赖全部安装完成后，再把镜像内 apt 源替换为内网 Nexus 代理，供容器运行时与预制工作负载使用。
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
# 运行期源（构建完成后写入镜像，均可通过同名 build-arg 覆盖）：
#   UBUNTU_MIRROR       apt 源（默认内网 Nexus ubuntu-proxy）
#   NPM_REGISTRY        npm/pnpm registry（默认内网 Nexus npm-proxy；以 ENV 固化供工作负载读取）
#
FROM ubuntu:24.04

ARG UBUNTU_MIRROR=http://nexus.internal.fffdan.com/repository/ubuntu-proxy/
ARG NPM_REGISTRY=https://nexus.internal.fffdan.com/repository/npm-proxy/
# .NET 由工作负载脚本经 apt 安装（不再依赖 dotnet-install.sh）。默认包名 dotnet10、默认执行 apt-get upgrade，
# 可在运行时用同名环境变量覆盖；如内网 Ubuntu 源不含 .NET 10，可用 DOTNET_APT_SOURCE/DOTNET_APT_KEY_URL
# 在构建期注入内部 Microsoft feed 代理（见下方「.NET apt 源」）。
ARG DOTNET_APT_PACKAGE=dotnet10
ARG DOTNET_APT_UPGRADE=1

ENV DEBIAN_FRONTEND=noninteractive

# 运行时环境变量：NPM_REGISTRY 供「Node.js」预制工作负载脚本（`REGISTRY="${NPM_REGISTRY:-...}"`）
# 与 entrypoint 自举后的 `npm config set registry` 读取，并以 ENV 固化供运行期工作负载继承。
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
#    注意：这里**不装** nodejs/npm；Node.js / npm / pnpm / agent-gear 统一由 entrypoint 启动时安装。
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
 && chmod 0440 /etc/sudoers.d/90-worker

# 4) 主目录工具链全部由 entrypoint 在启动时以 worker 用户安装（不进入镜像层）：
#    - entrypoint `bootstrap_home` 从内网 git 仓库安装版本管理器与 Node.js；
#    - `ensure_pnpm` 用 npm 自举固定版本 pnpm；
#    - `update_agent_gear` 用 pnpm 安装 / 更新 agent-gear；
#    - `/etc/profile.d` 下的登录 shell 接线同样由 entrypoint 幂等写入。
#    这样挂载云存储遮蔽 /home/worker 后不会丢失任何组件。
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 5) 构建完成后切换到内网 apt 源（供容器运行时与预制工作负载使用）
RUN printf 'Types: deb\nURIs: %s\nSuites: noble noble-updates noble-backports\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\nTypes: deb\nURIs: %s\nSuites: noble-security\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n' \
      "$UBUNTU_MIRROR" "$UBUNTU_MIRROR" \
      > /etc/apt/sources.list.d/ubuntu.sources \
 && rm -rf /var/lib/apt/lists/*

# 6) 默认启动命令即回连 cloud-controller（参数取自注入的环境变量）
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
