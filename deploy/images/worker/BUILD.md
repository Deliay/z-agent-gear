# 默认工作容器镜像构建与自验（内网环境）

> 该镜像依赖内网 Nexus（Ubuntu / GitHub raw / Node.js 发行包 / npm 代理）与 Harbor 镜像代理，
> **不在 GitHub CI 构建**（runner 不可达内网）。请在可访问内网的机器上执行构建与自验。
> 构建过程**不回退公网**：Node.js 与 npm 由 nvm 安装，nvm 及其发行包全部取自内网代理。

## 构建

```bash
cd deploy/images/worker
docker build -t core.harbor.internal.fffdan.com/zero-tools/worker:dev .

# 内网地址变化时通过 --build-arg 覆盖
docker build \
  --build-arg UBUNTU_MIRROR=https://nexus.internal.fffdan.com/repository/ubuntu-proxy/ \
  --build-arg GITHUB_RAW_PROXY=https://nexus.internal.fffdan.com/repository/github-raw-proxy \
  --build-arg NVM_VERSION=v0.40.8 \
  --build-arg NODEJS_DIST_MIRROR=https://nexus.internal.fffdan.com/repository/node-proxy \
  --build-arg NODE_VERSION=22 \
  --build-arg NPM_REGISTRY=https://nexus.internal.fffdan.com/repository/npm-proxy/ \
  -t core.harbor.internal.fffdan.com/zero-tools/worker:dev .
```

### .NET（apt）相关构建参数

`.NET` 预制工作负载改由**系统包管理器 apt** 安装（不再下载 `dotnet-install.sh`）：

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `DOTNET_APT_PACKAGE` | build-arg + 运行时 ENV | `dotnet10` | apt 包名；内网源包名不同时覆盖 |
| `DOTNET_APT_UPGRADE` | build-arg + 运行时 ENV | `1` | 是否执行 `apt-get -y upgrade`（排障/提速可置 `0`） |
| `DOTNET_APT_SOURCE` | build-arg（可选） | 空 | 内网 Ubuntu 源不含 `dotnet10` 时的 Microsoft feed 代理源 |
| `DOTNET_APT_KEY_URL` | build-arg（可选） | 空 | 与 `DOTNET_APT_SOURCE` 配套的签名密钥地址 |

`DOTNET_APT_SOURCE` 与 `DOTNET_APT_KEY_URL` 同时提供时，构建期会追加 `/etc/apt/sources.list.d/dotnet.list`；未提供则仅使用内网 Ubuntu 源（不阻断构建）。例如：

```bash
docker build \
  --build-arg DOTNET_APT_SOURCE=https://nexus.internal.fffdan.com/repository/dotnet-proxy/ubuntu/24.04/prod \
  --build-arg DOTNET_APT_KEY_URL=https://nexus.internal.fffdan.com/repository/dotnet-proxy/microsoft.asc \
  -t core.harbor.internal.fffdan.com/zero-tools/worker:dev .
```

构建完成后将镜像 `WORKER_IMAGE` 配置为 `core.harbor.internal.fffdan.com/zero-tools/worker:dev`（或推送后使用正式 tag）。

## 前置条件（nvm 走内网代理）

镜像内**不存在** apt 的 `nodejs`/`npm`，Node.js 与 npm 全部由 nvm 提供，且 nvm 安装脚本、nvm 脚本本体、
Node.js 发行包均只取自内网代理。构建前请确认以下地址可访问（应返回 200）：

```bash
BASE=https://nexus.internal.fffdan.com/repository/github-raw-proxy/nvm-sh/nvm/v0.40.8
for f in install.sh nvm.sh nvm-exec bash_completion; do
  printf '%s  %s\n' "$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$BASE/$f")" "$f"
done
curl -s -o /dev/null -m 20 -w 'node-proxy/index.tab: %{http_code}\n' \
  https://nexus.internal.fffdan.com/repository/node-proxy/index.tab
```

其中 `install.sh`（nvm 安装脚本）与 `nvm.sh`/`nvm-exec`/`bash_completion`（脚本内容）由 `GITHUB_RAW_PROXY`
提供，Node.js 的 `index.tab`/`SHASUMS256.txt`/`node-*.tar.xz` 由 `NODEJS_DIST_MIRROR` 提供。

> 若上述地址返回 404 / 提示 `Remote Auto Blocked`，说明 Nexus 侧到上游（raw.githubusercontent.com）
> 的通道不可用，需先恢复该代理仓库或预热缓存后再构建（Dockerfile 已用 `. "$NVM_DIR/nvm.sh"` 断言，
> nvm 脚本缺失会直接构建失败，不会静默产出残缺镜像）。

## 自验（PRD 功能点 1 验收标准：瘦身后通用能力可用）

```bash
docker run --rm -it --entrypoint bash \
  -e ZAG_SERVER_ENDPOINT=wss://example.invalid/worker \
  -e ZAG_CONTROLLER_KEY=dummy \
  core.harbor.internal.fffdan.com/zero-tools/worker:dev -lc '
    nvm --version && nvm ls && \
    which node npm && node -v && npm -v && npm config get registry && \
    git --version && gh --version && \
    agent-gear --version && agent-gear harness --help && \
    claude-agent-acp --help >/dev/null 2>&1 || true
  '
```

逐项核对：

- [ ] `node`、`git`、`gh` 可用；且 `which node` 指向 `/usr/local/nvm/current/bin/node`（已弃用 apt 的 node/npm）
- [ ] `nvm` 可用（登录 shell 通过 `/etc/profile.d/nvm.sh` 加载），`node -v` 版本符合 `NODE_VERSION`（默认 22.x）
- [ ] `npm config get registry` 为内网 npm 代理地址，且运行时 `NPM_REGISTRY` 环境变量已固化（`echo "$NPM_REGISTRY"`，供 Node.js 工作负载脚本读取）
- [ ] **镜像 3 个 npm 全局包**已安装：`agent-gear`、`@agentclientprotocol/claude-agent-acp`、`@agentclientprotocol/codex-acp`；**不预装** `@opencode/cli`（`command -v opencode` 应无输出）、`@moonshot-ai/kimi-code`（`command -v kimi` 应无输出）与 `@deepseek-ai/dsh`（`command -v dsh` 应无输出），三者分别由 OpenCode / Kimi Code / DeepSeek Harness 工作负载安装
- [ ] `agent-gear --version` ≥ `2.9.0`（`deepseek_harness` 的平台渠道模型注入与 `harness prepare` 分流自 2.9.0 起；`kimi_code` 使用前登录闸门自 2.8.0 起；云电脑双连接与 `harness prepare` 需 ≥ `2.5.0`、参数注入 ≥ `2.3.0`、`items[].required` 短路 ≥ `2.4.0`）

- [ ] `agent-gear harness --help` 可见 `prepare` 子命令
- [ ] **未选择「Docker」工作负载时容器内不存在 docker 能力**：`command -v docker` 无输出、`command -v dockerd` 无输出、`pgrep -a dockerd` 无输出、`[ ! -e /usr/local/bin/docker ]`
- [ ] **未选择「.NET」/「Aspire」时容器内不存在 .NET 能力**：`command -v dotnet` 无输出

> Docker（`docker buildx`、镜像代理拉取）与 .NET / Aspire 能力属工作负载范畴，验收见下方
> 「预制工作负载脚本手工验收（真实集群）」。
>
> **OpenCode 不属于镜像预装能力**：它由「OpenCode（Harness）」工作负载的 init 脚本按
> `OPENCODE_CLI_VERSION` 安装，因此镜像内 `opencode --version` 失败是**预期行为**，不阻断构建。
> 对应的硬校验发生在 harness 初始化阶段（见「OpenCode（Harness）工作负载自验」）。

### 镜像瘦身静态校验（工作负载四期）

Dockerfile / entrypoint 中不得再出现 Docker 预装或 shim 装配的残留（对应实现计划 裁决 9）：

```bash
cd deploy/images/worker
grep -nE 'docker-ce|docker-buildx|containerd\.io|DOCKER_APT_URL|docker\.asc|docker\.list' Dockerfile && exit 1 || true
grep -nE 'iptables|iproute2|fuse-overlayfs|libseccomp2|conntrack' Dockerfile && exit 1 || true
# 只禁旧版安装脚本环境变量残留；三期引入的 DOTNET_APT_* 为 .NET 工作负载的配置注入（不预装任何包），允许存在
grep -nE 'DOTNET_INSTALL_URL|ASPIRE_INSTALL_URL' Dockerfile && exit 1 || true
grep -nE 'install_docker_shim|DOCKER_SHIM_PATH|HARBOR_PROXY|dockerd' entrypoint.sh && exit 1 || true
echo "静态校验通过：镜像不含 Docker/.NET 预装与 shim 残留"
```

- [ ] 上述 `grep` 均无命中（无 `docker-ce` / `DOCKER_APT_URL` / `install_docker_shim` / `dockerd` 等残留）
- [ ] 镜像构建日志中不再出现 `docker-ce-cli` / `docker-buildx-plugin` / `containerd.io` 安装层

## 工作负载执行自验（PRD 功能点 3/5）

镜像内 `agent-gear` 需支持「工作负载」协议（`workload:run` / `workload:result`，见 `contracts/cloud-controller-websocket.md` §2.9/§2.10）。构建后核对：

```bash
docker run --rm -it --entrypoint bash \
  core.harbor.internal.fffdan.com/zero-tools/worker:dev -lc '
    agent-gear --version && \
    agent-gear harness --help && \
    { command -v kimi || echo "kimi not preinstalled (expected)"; } && \
    { command -v dsh || echo "dsh not preinstalled (expected)"; } && \
    bash -c "echo workload-ok" && \
    bash -c "echo out; echo err 1>&2; exit 7" ; echo "exit=$?"
  '
```

逐项核对：

- [ ] `agent-gear --version` ≥ `2.9.0`（普通容器注册门禁仍为 `>=2.2.0` 且 major 为 `2`；harness 容器门禁基线 `2.6.0`，含 `kimi_code` 的运行要求 `2.8.0`、含 `deepseek_harness` 要求 `2.9.0`；参数注入 ≥ `2.3.0`、必须项短路 ≥ `2.4.0`）
- [ ] `agent-gear harness --help` 输出包含 `prepare`
- [ ] `bash -c <script>` 可执行且 stdout/stderr 均被捕获（执行器合并捕获）
- [ ] 非零退出码被如实回报（`failed` + exitCode）；超时脚本会被强制终止（杀进程组）
- [ ] 单条输出超过 256 KiB 时按尾部截断

### 参数注入自验（`WORKLOAD_PARAMS` / `WORKLOAD_PARAM_*`）

参数由 cloud-controller 经 `workload:run` 下发，worker 以 `process.env` 为基础按 item 注入环境变量后执行
`bash -c <script>`（契约 §2.9「参数注入约定」）。镜像内可脱离服务端直接模拟注入语义：

```bash
docker run --rm --entrypoint bash \
  -e WORKLOAD_PARAMS='{"version":"22","package_manager":["pnpm"],"debug":true}' \
  -e WORKLOAD_PARAM_VERSION=22 \
  -e WORKLOAD_PARAM_PACKAGE_MANAGER='["pnpm"]' \
  -e WORKLOAD_PARAM_DEBUG=true \
  core.harbor.internal.fffdan.com/zero-tools/worker:dev -lc '
    echo "params=$WORKLOAD_PARAMS"
    echo "version=$WORKLOAD_PARAM_VERSION"
    echo "debug=$WORKLOAD_PARAM_DEBUG"
    node -e "const v = JSON.parse(process.env.WORKLOAD_PARAM_PACKAGE_MANAGER || \"[]\"); console.log(\"package_manager=\" + v.join(\",\"))"
  '
```

逐项核对：

- [ ] `WORKLOAD_PARAMS` 为完整参数 JSON（无参数时为 `{}`）
- [ ] `WORKLOAD_PARAM_<KEY_UPPER>` 单值编码正确：字符串原样、布尔 `"true"`/`"false"`、多选为 JSON 数组字符串（如 `["pnpm"]`）
- [ ] 多选参数可由脚本自行 `JSON.parse`（预制 Node.js 脚本用容器内 Node 解析）
- [ ] 未选择任何参数时行为与旧版一致（仅注入 `WORKLOAD_PARAMS={}`）

### OpenCode（Harness）工作负载自验

镜像**不预装** `@opencode/cli`；OpenCode 由「OpenCode（Harness）」工作负载（admin-api 迁移 005）在
`init` 阶段按固定版本安装，随后执行 `opencode --version` 硬校验与 `agent-gear harness prepare`。
任一失败以非零退出，`required=true` 会触发 cloud-controller 强制注销容器。

`OPENCODE_CLI_VERSION` 锁定口径：

- 迁移 005 脚本内硬编码默认值（当前 `2.1.1`）；**验收以该固定版本为准**。
- 实施/升级时用 `npm view @opencode/cli versions --json` 实测确认内网 npm 代理可用版本，再把默认值写回迁移脚本与本文档。
- 运行时可经同名 env `OPENCODE_CLI_VERSION` 覆盖（仅排障/临时验证，不作为验收依据）。

真实集群启动一个 harness 云电脑后，在容器内自验：

```bash
# 1) OpenCode 已由 harness 工作负载安装，且版本与 OPENCODE_CLI_VERSION 一致
opencode --version

# 2) 模型配置已写入（providers.zag；保留既有 provider/注释）
agent-gear harness prepare           # 幂等：重复执行只替换 providers.zag
cat ~/.config/opencode/opencode.jsonc
stat -c '%a' ~/.config/opencode/opencode.jsonc   # 期望 600

# 3) 默认工作区已创建
test -d "${ZAG_DEFAULT_WORKSPACE:-/root/workspace}" && echo workspace-ok

# 4) 日志不含模型/控制器 Key（secret 脱敏为 ***）
#    检查 cloud-controller 的 workload 日志与容器 stdout
```

逐项核对：

- [ ] 镜像内 `command -v opencode` 无输出（未预装）；harness 初始化后 `opencode --version` 成功
- [ ] 安装版本为 `OPENCODE_CLI_VERSION` 固定值（默认 `2.1.1`），非 `latest`
- [ ] `agent-gear harness prepare` 成功；`opencode.jsonc` 的 `providers.zag` 含 `settings.baseURL`/`settings.apiKey`/`models`，权限 `600`
- [ ] 重复执行 `agent-gear harness prepare` 不破坏既有 `provider`/注释（幂等）
- [ ] `ZAG_DEFAULT_WORKSPACE` 已创建；`ZAG_MODEL_API_KEY`/`ZAG_HOST_KEY`/`ZAG_CONTROLLER_KEY` 不出现在日志/错误中
- [ ] 缺失 harness env 或 `opencode` 不可用时，init 工作负载失败 → 容器被强制注销（不上线）

### DeepSeek Harness（Harness）工作负载自验

镜像**不预装** `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-acp-app`；二者由「DeepSeek Harness（Harness）」工作负载
（admin-api 迁移 010）在 `init` 阶段**双包同版本安装**：`@deepseek-ai/dsh` 提供 `dsh` bin，
`@deepseek-ai/dsh-acp-app` 是 profile 组合包（无 bin）。随后执行 `dsh --version` 硬校验与
`agent-gear harness prepare`（`ZAG_HARNESS_TYPES` 含 `deepseek_harness`）。任一失败以非零退出，
`required=true` 会触发 cloud-controller 强制注销容器。

`DSH_CLI_VERSION` / `DSH_ACP_APP_VERSION` 锁定口径：

- 迁移 010 脚本内硬编码默认值（当前 `0.1.2-alpha.2`）；**验收以该固定版本为准**。
- 运行时可经同名 env 覆盖（仅排障/临时验证，不作为验收依据）。

真实集群启动一个仅选 DeepSeek Harness 的云电脑后，在容器内自验：

```bash
# 1) dsh 由 harness 工作负载安装，且版本与 DSH_CLI_VERSION 一致（输出纯版本号）
dsh --version

# 2) 注入文件已写入、权限正确
agent-gear harness prepare                        # 幂等：按 id 替换 patch 条目
cat ~/.dsh/profiles/acp/cordis.patch.yml          # llm-deepseek 禁用 + providers.zag + 默认路由
stat -c '%a' ~/.dsh/profiles/acp                 # 期望 700
stat -c '%a' ~/.dsh/.credentials.yaml            # 期望 600
dsh --dump-config | head -n 40                   # patch 归属与 acp profile 组合树

# 3) 默认工作区已创建
test -d "${ZAG_DEFAULT_WORKSPACE:-/root/workspace}" && echo workspace-ok

# 4) 日志不含模型 Key（secret 脱敏为 ***）
```

逐项核对：

- [ ] 镜像内 `command -v dsh` 无输出（未预装）；harness 初始化后 `dsh --version` 为固定值
- [ ] `~/.dsh/profiles/acp/cordis.patch.yml` 含 `llm-deepseek.disabled=true`、`providers.zag`（`apiKeyEnv` 引用而非明文 Key）与 `agent-default-model`/`acp` 默认路由
- [ ] `.credentials.yaml` 为 `version: 1` + `refs.ZAG_MODEL_API_KEY`，权限 `600`；patch 目录 `700`
- [ ] 重复执行 `agent-gear harness prepare` 幂等（4 条目按 id 替换、非我方条目与注释保留）
- [ ] `dsh --profile acp` 可拉起会话，模型选择仅 `ZAG` 组、默认选中，无内建官方渠道分组、无登录引导
- [ ] `ZAG_MODEL_API_KEY` 不出现在日志/错误/命令行；缺失 harness env 或 `dsh` 不可用时 init 失败 → 容器被强制注销

### 预制工作负载脚本手工验收（真实集群）

在挂载了「Docker」/「Node.js」/「.NET」/「Aspire」工作负载的容器内，按初始化顺序逐项核对脚本产物：

```bash
# Docker（首个执行；未选择时容器内不应存在 docker/dockerd）
docker info                          # 脚本执行后 dockerd 已就绪；未选择 Docker 时此命令应失败
pgrep -a dockerd                     # 仅在选择「Docker」工作负载后才有输出
docker version                       # CLI 可用
docker buildx version                # 镜像构建能力可用
docker pull ubuntu:24.04             # 拉取 Docker Hub 镜像走代理
docker pull ghcr.io/<owner>/<image>  # 拉取 ghcr 镜像走代理

# Node.js（参数 version / package_manager）
nvm ls && node -v && npm -v && npm config get registry
node -e 'console.log(JSON.parse(process.env.WORKLOAD_PARAM_PACKAGE_MANAGER || "[]"))'   # 多选参数可解析

# .NET（apt 安装；幂等：已装 .NET 10 再次执行直接成功）
dotnet --list-sdks                 # 应显示 10.x（apt 提供 /usr/bin/dotnet，不依赖 dotnet-install.sh）
command -v dotnet                  # 命中 /usr/bin/dotnet
bash -c 'test ! -e /tmp/dotnet-install.sh'   # 不再下载 dotnet-install.sh

# Aspire（依赖 Docker + .NET，最后执行；成功判据为 CLI 可执行；下载来源为「Aspire」工作负载参数
# `aspire_cli_url`——迁移 004 默认填入内网缓存代理安装包直链，启动时可按次调整，运行时
# `ASPIRE_CLI_URL` 环境变量可覆盖且优先；脚本本身不内置默认值）
aspire --version
```

逐项核对：

- [ ] 未选择「Docker」工作负载时容器内**没有** docker/dockerd（入口不装配 shim、不启动 dockerd，全部由 Docker 脚本负责）；选择后 `docker info` 可用
- [ ] 选择「Docker」后 `docker version`、`docker buildx version` 均成功；重复执行 Docker 脚本幂等收敛（不重复安装/不重复启动）
- [ ] 拉取 Docker Hub 镜像走代理：`docker pull ubuntu:24.04` 实际拉取 `core.harbor.internal.fffdan.com/docker-hub-proxy/ubuntu:24.04`
- [ ] 拉取 ghcr 镜像走代理：`docker pull ghcr.io/<owner>/<image>` 实际拉取 `core.harbor.internal.fffdan.com/ghcr/<owner>/<image>`
- [ ] **安装来源默认已填且可达**：「Docker」工作负载参数 `docker_apt_url` 默认已填内网代理地址 `https://nexus.internal.fffdan.com/repository/docker-ce-apt`（实测该仓库根即 apt 源根，地址形态为 `https://<nexus-host>/repository/<docker-ce-apt>/`），并核对 `curl -fsS "<地址>/gpg"` 返回 200
- [ ] 清空 `docker_apt_url` 参数（且未提供 `DOCKER_APT_URL`）且组件尚未安装时：该工作负载**快速失败**并在执行记录中给出含正确地址形态的明确指引（容器仍继续后续初始化并上线）
- [ ] 安装来源不可达时该工作负载记录失败与日志，容器仍继续后续初始化并上线
- [ ] Node.js 脚本按 `version` 参数安装/切换版本、按 `package_manager` 多选安装包管理器，`npm config get registry` 为内网代理
- [ ] .NET 脚本经 **apt** 安装 .NET 10：`dotnet --list-sdks` 显示 `10.x`、`command -v dotnet` 命中 `/usr/bin/dotnet`、**不依赖 `dotnet-install.sh`**；重复执行幂等（已装 .NET 10 直接成功）
- [ ] `DOTNET_APT_PACKAGE`（默认 `dotnet10`）/`DOTNET_APT_UPGRADE`（默认 `1`）在运行时生效；`DOTNET_APT_UPGRADE=0` 时跳过 `apt-get upgrade`
- [ ] Aspire 脚本前置检查（`command -v dotnet`）通过，下载安装 CLI 后 `aspire --version` 输出非空（不能仅以下载/安装步骤返回 0 判成功）
- [ ] **下载来源默认已填且可达**：「Aspire」工作负载参数 `aspire_cli_url` 默认已填内网缓存代理安装包直链 `https://nexus.internal.fffdan.com/repository/misc-cache/dotnet/aspire-cli-linux-x64.tar.gz`；核对 `curl -fsS "<地址>"` 返回 200（`content-type: application/x-gzip`）
- [ ] 清空 `aspire_cli_url` 参数（且未提供 `ASPIRE_CLI_URL`）且 Aspire 尚未安装时：该工作负载**快速失败**并在执行记录中给出含正确地址形态的明确指引（容器仍继续后续初始化并上线）
- [ ] 下载地址不可达时该工作负载记录失败与日志，容器仍继续后续初始化并上线

> **安装来源（重要）**：默认来源由「Docker」工作负载参数 `docker_apt_url` 提供——迁移 003 默认填入内网
> Docker CE apt 代理地址 `https://nexus.internal.fffdan.com/repository/docker-ce-apt`（实测该仓库根即 apt 源根，
> 地址形态 `https://<nexus-host>/repository/<docker-ce-apt>/`），启动时可按环境调整；脚本本身**不内置默认值**，
> 运行时 `DOCKER_APT_URL` 环境变量可覆盖且优先。清空参数且需安装时快速失败、打印指引并不影响容器其余初始化。
> 安装包列表为 `docker-ce docker-ce-cli docker-buildx-plugin containerd.io`：其中 `docker-ce` 提供 `dockerd`
> （守护进程），`docker-ce-cli` 仅提供客户端，四者缺一不可；**默认不指向公网**。
>
> **Aspire 安装来源**：默认来源由「Aspire」工作负载参数 `aspire_cli_url` 提供——迁移 004 默认填入内网缓存代理
> 安装包直链 `https://nexus.internal.fffdan.com/repository/misc-cache/dotnet/aspire-cli-linux-x64.tar.gz`（实测
> `application/x-gzip`），启动时可按环境调整；脚本本身**不内置默认值**，运行时 `ASPIRE_CLI_URL` 环境变量可覆盖
> 且优先。脚本直接下载安装包并解压到 `~/.aspire/bin` 后校验，**不再执行官方安装脚本**（`ASPIRE_INSTALL_URL`
> 随官方安装脚本退役）。清空参数且需安装时快速失败、打印含地址形态的指引并不影响容器其余初始化。

> 工作负载脚本由 cloud-controller 经 Socket.IO 下发（不经 K8s env / Job manifest 注入），
> 因此变更后**需重新构建并推送 worker 镜像**（`entrypoint.sh` 的启动更新与版本不匹配自升级逻辑见下文「默认启动」）。

### 必须工作负载失败强制注销手工验收（真实集群）

前置：cloud-controller 已部署工作负载三期（支持 `workloadPlan[].required` 与必须失败裁决），worker 镜像内 `agent-gear` ≥ `2.4.0`（当前镜像为 2.5.x）。

内网 K8s 受控验收步骤：

1. 在管理后台「云端容器」启动对话框为一个含初始化脚本的工作负载勾选「必须」，并让该脚本**必然失败**（例如 `exit 1`），确认顺序预览出现「必须」标识；
2. 启动后观察 cloud-controller 日志：出现「必须工作负载初始化失败」相关记录，容器被强制注销；
3. 核对容器列表/详情：容器状态最终为「已退出」，**退出原因包含该工作负载名称**（`必须工作负载「<name>」初始化失败`），且**未上线**；
4. 核对「工作负载日志」：该必须项为「失败」、后续被中断条目为「超时」并带「必须工作负载初始化失败，已中断」说明，必须项有「必须」标识；
5. 核对凭据失效：容器的一次性 token 在其宽限期内已失效（`destroying` 终态），worker 无法回连成功；容器内不存在残留 K8s Job（已回收/显式标注需人工清理）；
6. 反例：将同一工作负载取消「必须」后启动，脚本失败时容器仍可上线（行为与现状一致）。

逐项核对：

- [ ] 必须项失败 → 中断剩余初始化 + 强制注销 + 退出原因含负载名，容器不上线
- [ ] 不重试、不退避（无 backoff 循环）；凭据在宽限前失效、K8s Job 被回收
- [ ] 非必须项失败维持现状（容器可上线）

## 默认启动

容器默认 `ENTRYPOINT` 为 `entrypoint.sh`，启动流程：

1. 执行 `npm install -g agent-gear` 更新到最新版（失败仅告警、回退镜像内预装版本；设 `ZAG_SKIP_AGENT_GEAR_UPDATE=1` 可跳过）；
2. 以受监督方式运行 `agent-gear`（参数取自 `ZAG_SERVER_ENDPOINT` / `ZAG_CONTROLLER_KEY`）回连 cloud-controller。

> 云电脑（harness）容器额外注入标准连接凭据：`ZAG_HOST_ENDPOINT` + `ZAG_HOST_KEY`（controller-api），
> agent-gear 检测到后进入**双连接**模式（详见 `packages/agent-controller/AGENTS.md`）。`ZAG_CONTROLLER_KEY`
> 始终是 `/worker` 一次性 token，**不是**控制器 Key；`ZAG_HOST_KEY` 仅经握手 `auth.token` 携带，不进 URL。
> 普通 idle 容器不含 `ZAG_HOST_*`，行为与旧版完全一致。

> 入口**不**装配任何 docker shim、**不**调用 docker、也**不**启动 dockerd —— 容器内 docker 能力
> （CLI、镜像代理 shim、dockerd）全部由「Docker」工作负载的初始化脚本按需提供（工作负载四期）。

受监督运行的行为（版本门禁与自恢复，见 `docs/engineering/plan/20261017-feat-controller-version-requirement.md`）：

- `cloud-controller` 要求普通 worker 版本 `>=2.2.0` 且 major 为 `2`、harness（云电脑）worker 版本 `>=2.5.0`；不兼容时返回 `error { code: "VERSION_MISMATCH", currentVersion, minimumVersion, supportedMajor }` 并断开，**不**将容器置为 online / initializing。
- 入口对 agent-gear 的 stderr 做流式扫描（实时透传、不落盘完整日志），仅在「非零退出 + 出现 `VERSION_MISMATCH` + 本轮未升级 + 未设置 `ZAG_SKIP_AGENT_GEAR_UPDATE=1`」时执行**一次** `npm install -g agent-gear --no-fund --no-audit`，升级成功后重启并重连。
- 安装失败、升级后仍不匹配、第二次不匹配、普通非零退出、正常退出均不会形成升级/重连循环；失败时容器非零退出，管理员可用既有强制销毁回收。
- 入口作为 PID 1 向 agent-gear / npm 子进程转发 `SIGTERM` / `SIGINT` 并等待退出；收到销毁信号后不再拉起控制器。
- 启动更新与版本不匹配恢复都受 `ZAG_SKIP_AGENT_GEAR_UPDATE=1` 控制（离线/排障出口）。

## 版本门禁与自升级自验

不需要真实 npm 网络或 dockerd 的静态/自动化自验：

```bash
cd deploy/images/worker
bash -n entrypoint.sh
bash entrypoint.test.sh
```

自动化用例覆盖：入口不装配 docker shim、不调用 docker/dockerd（T-EP0）、入口源码不含 `install_docker_shim`/`DOCKER_SHIM_PATH`/`HARBOR_PROXY` 残留（T-EP0a）、首轮旧版被拒 → 一次升级 → 重连成功（T-EP1）、安装失败（T-EP2）、升级后仍不兼容（T-EP3）、`ZAG_SKIP_AGENT_GEAR_UPDATE=1`（T-EP4）、普通错误/正常退出不升级（T-EP5/T-EP6）、`SIGTERM`/`SIGINT` 转发且不重启（T-EP7）、日志有界与透传（T-EP8）。测试使用临时 PATH stub（假 `docker`/`dockerd`/`npm`/`agent-gear`），其中 `docker`/`dockerd` stub 仅作哨兵（入口一旦调用即落标记，T-EP0 断言标记为空），因此不会启动真实 dockerd、不访问网络。

> **镜像升级要求**：云电脑双连接 / `harness prepare` 依赖 `agent-gear` ≥ `2.5.0`（harness 容器门禁）；工作负载「必须」短路依赖 ≥ `2.4.0`，参数注入依赖 ≥ `2.3.0`。普通容器门禁常量 `MIN_WORKER_VERSION` 仍为 `2.2.0`（2.2.0 worker 仍能执行不带参数的脚本，且必须失败由服务端裁决、旧 worker 忽略 `required` 仍正确），但只有重建为 ≥ `2.5.0` 的 worker 镜像才能承载 harness 云电脑。变更 `entrypoint.sh`/`Dockerfile` 后必须**重新构建并推送 worker 镜像**，并让新容器指向新 tag；已在运行的旧入口容器需强制销毁重建。

内网 K8s 受控验收（发布顺序见技术提案 §9.1）：

1. 构建并推送包含新 `entrypoint.sh` 的 worker 镜像，将新工作容器 `WORKER_IMAGE` 指向该镜像；
2. 部署带版本门禁的 `cloud-controller` 后，启动一个挂载初始化脚本的容器，确认日志出现 `VERSION_MISMATCH`（含当前/最低版本）→ `upgrading agent-gear after VERSION_MISMATCH` → `agent-gear upgraded: <version>` → 重连后初始化脚本被执行；
3. 对该容器执行强制销毁，确认即时完成（版本被拒期间从未写 `connectedAt`，不等待 post/shutdown 宽限）；
4. 用受控旧版 `agent-gear 2.1.0`（镜像内预装旧版且启动更新失败）验证一次自升级重连；再次模拟升级源不可用时确认容器非零退出且可强制销毁；
5. 核对日志不含 `ZAG_CONTROLLER_KEY`、token 或带凭据 URL。

> 已运行中的旧入口容器无法远程获得新恢复逻辑，需在门禁上线后**强制销毁重建一次**。


## 已知限制

- sysbox 为**节点级** runtime（`sysbox-runc`），集群节点需预装 sysbox，否则带 `runtimeClassName: sysbox-runc` 的 Pod 无法调度。集群未启用 sysbox 时可将 `RUNTIME_CLASS_NAME` 置空/改用其他 runtime。
- 镜像代理 shim 由「Docker」工作负载脚本在安装 CLI 后装配（`/usr/local/bin/docker`），采用「首个非选项参数即镜像引用」的启发式改写，覆盖 `docker pull/run/create` 的常规用法；复杂 `docker build` 的 `FROM` 需在 Dockerfile 中直接书写代理地址（或使用 Harbor 代理前缀）。未选择「Docker」工作负载时容器内不存在该 shim。
- 工作容器基础环境不再预装 Docker / .NET，改由对应预制工作负载脚本在初始化阶段按需安装。安装源：Docker 由工作负载参数 `docker_apt_url` 提供（迁移 003 默认填入内网代理地址 `https://nexus.internal.fffdan.com/repository/docker-ce-apt`，可启动时按次调整；`DOCKER_APT_URL` 环境变量可覆盖且优先），脚本本身不内置默认值，清空参数且需安装时快速失败并给出指引；.NET 脚本经 **apt** 安装（内网 Ubuntu 源，必要时经 `DOTNET_APT_SOURCE`/`DOTNET_APT_KEY_URL` 追加 Microsoft feed 代理源，见上文「.NET（apt）相关构建参数」）；Aspire 由工作负载参数 `aspire_cli_url` 提供内网缓存代理安装包直链（迁移 004 默认填入 `https://nexus.internal.fffdan.com/repository/misc-cache/dotnet/aspire-cli-linux-x64.tar.gz`，可启动时按次调整；`ASPIRE_CLI_URL` 环境变量可覆盖且优先），脚本本身不内置默认值，清空且未安装时快速失败并给出指引。任一来源不可达时该工作负载记录失败并保留日志，容器仍继续后续初始化并上线（沿用一期失败策略）。
