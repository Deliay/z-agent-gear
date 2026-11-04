# 默认工作容器镜像构建与自验

> 构建期只使用**官方公网 Ubuntu archive**，因此可在 GitHub Actions 等公网环境构建。
> 主目录工具链（nvm / Node.js / pnpm / agent-gear）**不在构建期安装**，由入口 `entrypoint.sh` 在容器
> 启动时以 **worker 用户**从内网源幂等安装——这样云存储 PVC 挂载到 `/home/worker` 后组件不会丢失。
> 构建完成后镜像内的 apt 源切换为**内网 Nexus**，供容器运行时与预制工作负载使用。

## 构建

```bash
cd deploy/images/worker
docker build -t core.harbor.internal.fffdan.com/zero-tools/worker:dev .

# 运行期内网源变化时通过 --build-arg 覆盖（不影响构建期使用的官方源）
docker build \
  --build-arg UBUNTU_MIRROR=https://nexus.internal.fffdan.com/repository/ubuntu-proxy/ \
  --build-arg NPM_REGISTRY=https://nexus.internal.fffdan.com/repository/npm-proxy/ \
  -t core.harbor.internal.fffdan.com/zero-tools/worker:dev .
```

| 参数 | 生效阶段 | 默认 | 说明 |
|------|---------|------|------|
| `UBUNTU_MIRROR` | 运行期 | 内网 `ubuntu-proxy` | 构建完成后写入 `/etc/apt/sources.list.d/ubuntu.sources` |
| `NPM_REGISTRY` | 运行期 | 内网 `npm-proxy` | 固化为 ENV；entrypoint 安装 pnpm / agent-gear 与运行时工作负载使用 |

> nvm / Node.js 的安装来源不再通过 `--build-arg` 传入：默认值收敛在 `entrypoint.sh`，可在运行时用
> 同名环境变量覆盖（见下表「运行时主目录工具链参数」）。

### 运行时主目录工具链参数（entrypoint 读取）

| 环境变量 | 默认 | 说明 |
|---------|------|------|
| `NVM_INSTALL_URL` | 内网 `git.internal.fffdan.com/nvm-sh/nvm/raw/branch/master/install.sh` | nvm 安装脚本地址 |
| `NVM_SOURCE` | 内网 `https://git.internal.fffdan.com/nvm-sh/nvm.git` | nvm git 仓库地址（安装脚本 `METHOD=git` 使用） |
| `NVM_INSTALL_VERSION` | `master` | 安装脚本检出的 git 引用；内网镜像仅同步 master，无 tag |
| `NODE_VERSION` | `24` | 由 nvm 安装的 Node.js 主版本 |
| `NVM_NODEJS_ORG_MIRROR` | 内网 `node-proxy` | nvm 安装 Node.js 的发行包源 |

### .NET（apt）相关构建参数

`.NET` 预制工作负载改由**系统包管理器 apt** 安装（不再下载 `dotnet-install.sh`）：

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `DOTNET_APT_PACKAGE` | build-arg + 运行时 ENV | `dotnet10` | apt 包名；内网源包名不同时覆盖 |
| `DOTNET_APT_UPGRADE` | build-arg + 运行时 ENV | `1` | 是否执行 `apt-get -y upgrade`（排障/提速可置 `0`） |
| `DOTNET_APT_SOURCE` | build-arg（可选） | 空 | 内网 Ubuntu 源不含 `dotnet10` 时的 Microsoft feed 代理源 |
| `DOTNET_APT_KEY_URL` | build-arg（可选） | 空 | 与 `DOTNET_APT_SOURCE` 配套的签名密钥地址 |

`DOTNET_APT_SOURCE` 与 `DOTNET_APT_KEY_URL` 同时提供时，会写入 `/etc/apt/sources.list.d/dotnet.list`
（供运行时工作负载使用）；未提供则运行时仅使用 `UBUNTU_MIRROR`（不阻断构建）。例如：

```bash
docker build \
  --build-arg DOTNET_APT_SOURCE=https://nexus.internal.fffdan.com/repository/dotnet-proxy/ubuntu/24.04/prod \
  --build-arg DOTNET_APT_KEY_URL=https://nexus.internal.fffdan.com/repository/dotnet-proxy/microsoft.asc \
  -t core.harbor.internal.fffdan.com/zero-tools/worker:dev .
```

构建完成后将镜像 `WORKER_IMAGE` 配置为 `core.harbor.internal.fffdan.com/zero-tools/worker:dev`（或推送后使用正式 tag）。

> 主目录工具链参数由入口 `bootstrap_home` 读取：首次启动（以及挂载云存储遮蔽 `/home/worker` 后）
> 会用它们重装 nvm/Node（见下文「云存储主目录自举自验」）。内网地址变化时可用运行时环境变量覆盖，
> 无需改 `entrypoint.sh`；确需固化新默认值时修改 `entrypoint.sh` 顶部默认值。

## 前置条件（构建期公网 / 首次启动内网）

镜像内**不存在** apt 的 `nodejs`/`npm`，也**不预装** nvm / Node.js / pnpm / agent-gear。构建期只需可访问
`archive.ubuntu.com` / `security.ubuntu.com`；构建完成后镜像内的 apt 源已切换为内网 Nexus。

首次启动（以及挂载云存储后）需要内网可访问：

```bash
for u in \
  https://git.internal.fffdan.com/nvm-sh/nvm/raw/branch/master/install.sh \
  https://git.internal.fffdan.com/nvm-sh/nvm.git \
  https://nexus.internal.fffdan.com/repository/node-proxy/index.tab \
  https://nexus.internal.fffdan.com/repository/npm-proxy/pnpm; do
  printf '%s  %s\n' "$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$u")" "$u"
done
```

> **不挂载云存储的云电脑同样在首次启动时走这套自举**：内网源可达时正常安装并上线，不依赖
> `ZAG_STORAGE_HOME`。若安装源不可达：挂载云存储（`ZAG_STORAGE_HOME=1`）会快速失败并触发存储回滚；
> 未挂载存储时入口仅告警并继续保活（等待后续重试，但首次安装失败期间无法上线）。构建阶段不再校验这些地址。

## 自验（PRD 功能点 1 验收标准：瘦身后通用能力可用）

### 1) 构建产物静态核对（不启动入口）

```bash
IMG=core.harbor.internal.fffdan.com/zero-tools/worker:dev
docker run --rm --entrypoint bash "$IMG" -c '
  for c in node npm pnpm agent-gear nvm; do
    command -v "$c" >/dev/null 2>&1 && { echo "$c unexpectedly preinstalled"; exit 1; } || true
  done
  git --version && gh --version
  echo "no main-home toolchain preinstalled (expected)"
'
```

### 2) 首次启动由 entrypoint 以 worker 安装（tmpfs 模拟空主目录 / 云存储挂载）

```bash
docker run -d --name worker-bootstrap \
  --tmpfs /home/worker:rw,exec,uid=1000,gid=1000 \
  -e ZAG_STORAGE_HOME=1 \
  -e ZAG_SERVER_ENDPOINT=wss://example.invalid/worker \
  -e ZAG_CONTROLLER_KEY=dummy \
  "$IMG"
docker logs -f worker-bootstrap   # 期望 bootstrap_home / pnpm / agent-gear 安装锚点
docker exec worker-bootstrap bash -lc '
  sudo -u worker env HOME=/home/worker \
    PATH="/home/worker/.nvm/current/bin:/home/worker/.local/share/pnpm/bin:/home/worker/.local/share/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    bash -c "
      node -v && npm -v && pnpm -v && npm config get registry && \
      agent-gear --version && agent-gear harness --help >/dev/null && \
      { command -v claude-agent-acp || echo \"claude-agent-acp not preinstalled (expected)\"; } && \
      { command -v codex-acp || echo \"codex-acp not preinstalled (expected)\"; }
    "
'
docker rm -f worker-bootstrap
```

> root 环境没有 nodejs（按设计由 worker 用户承载），因此运行期自验命令统一经 `sudo -u worker` 并显式
> 构造 `PATH`（nvm current/bin + pnpm 全局 bin + PNPM_HOME）。

逐项核对：

- [ ] 构建产物内 `node` / `npm` / `pnpm` / `agent-gear` / `nvm` 均**未预装**；`git`、`gh` 可用
- [ ] 首次启动日志依次出现 nvm（自定义 git 仓库）→ Node.js → pnpm → agent-gear 安装锚点
- [ ] worker 下 `which node` 指向 `/home/worker/.nvm/current/bin/node`，root 环境无 node/npm
- [ ] `nvm` 可用（登录 shell 通过入口写入的 `/etc/profile.d/nvm.sh` 加载），`node -v` 版本符合 `NODE_VERSION`（默认 24.x）
- [ ] `npm config get registry` 为内网 npm 代理地址，且运行时 `NPM_REGISTRY` 环境变量已固化（`echo "$NPM_REGISTRY"`，供 Node.js 工作负载脚本读取）
- [ ] `pnpm -v` 为 `12.16.1`，且 `PATH` 含 `/home/worker/.local/share/pnpm/bin`（pnpm 12 全局 bin 目录）
- [ ] 运行期全局包仅 `pnpm` 与 `agent-gear`；**不预装** `@agentclientprotocol/claude-agent-acp`（`command -v claude-agent-acp` 应无输出）与 `@agentclientprotocol/codex-acp`（`command -v codex-acp` 应无输出），二者由用户按需安装（agent-controller 仍保留探测与启动能力）；**不预装** `@opencode/cli`（`command -v opencode` 应无输出）、`@moonshot-ai/kimi-code`（`command -v kimi` 应无输出）与 `@deepseek-ai/dsh`（`command -v dsh` 应无输出），三者分别由 OpenCode / Kimi Code / DeepSeek Harness 工作负载安装
- [ ] `agent-gear --version` ≥ `2.11.0`（`deepseek_harness` 的平台渠道模型注入与 `harness prepare` 分流自 2.9.0 起，`cordis.patch.yml` 的 insert 受管条目 `header-masq`（dsh-header-masq 会话标识请求头注入）自 2.11.0 起；`kimi_code` 使用前登录闸门自 2.8.0 起；云电脑双连接与 `harness prepare` 需 ≥ `2.5.0`、参数注入 ≥ `2.3.0`、`items[].required` 短路 ≥ `2.4.0`）

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
# 主目录工具链（nvm/Node/pnpm/agent-gear）不得在构建期安装或固化相关 ARG/ENV
grep -nE 'USER worker|NVM_|NODE_VERSION|NODEJS_DIST_MIRROR|PNPM_HOME|npm install -g|pnpm add -g' Dockerfile && exit 1 || true
echo "静态校验通过：镜像不含 Docker/.NET 预装、shim 残留与主目录工具链构建期安装"
```

- [ ] 上述 `grep` 均无命中（无 `docker-ce` / `DOCKER_APT_URL` / `install_docker_shim` / `dockerd` 等残留）
- [ ] Dockerfile 不含 `USER worker` / `NVM_` / `NODE_VERSION` / `PNPM_HOME` / `npm install -g` / `pnpm add -g`
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

- [ ] `agent-gear --version` ≥ `2.11.0`（普通容器注册门禁仍为 `>=2.2.0` 且 major 为 `2`；harness 容器门禁基线 `2.10.0`，含 `deepseek_harness` 的运行 `2.11.0`（header-masq 配置注入），仅 opencode / 含 `kimi_code` 组合仍 `2.10.0`；参数注入 ≥ `2.3.0`、必须项短路 ≥ `2.4.0`）
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

镜像**不预装** `@opencode/cli`；OpenCode 由「OpenCode（Harness）」工作负载（admin-api 迁移 006）在
`init` 阶段按固定版本安装，随后执行 `opencode --version` 硬校验与按类型限定的
`ZAG_HARNESS_TYPES=opencode agent-gear harness prepare`（多 harness 主机顺序安装 CLI，裸调用会对
尚未安装的类型硬校验而误失败）。
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
test -d "${ZAG_DEFAULT_WORKSPACE:-/home/worker/workspace}" && echo workspace-ok

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
（admin-api 迁移 013）在 `init` 阶段**双包同版本安装**：`@deepseek-ai/dsh` 提供 `dsh` bin，
`@deepseek-ai/dsh-acp-app` 是 profile 组合包（无 bin）。随后执行 `dsh --version` 硬校验、会话标识插件安装
（`dsh plugin --profile acp add Deliay/dsh-header-masq`；镜像预装 pnpm，脚本内仍保留固定版本自举兜底）与按类型限定的
`ZAG_HARNESS_TYPES=deepseek_harness agent-gear harness prepare`（`ZAG_HARNESS_TYPES` 前缀限定本类型，
多 harness 主机顺序安装 CLI 时裸调用会对尚未安装的类型硬校验而误失败）。任一失败以非零退出，
`required=true` 会触发 cloud-controller 强制注销容器。

`DSH_CLI_VERSION` / `DSH_ACP_APP_VERSION` 锁定口径：

- 迁移 013 脚本内硬编码默认值（当前 `0.2.1-rc.2`，dsh-header-masq 插件兼容下限 `>=0.2.1-rc.2 <0.3.0`）；**验收以该固定版本为准**。
- 运行时可经同名 env 覆盖（仅排障/临时验证，不作为验收依据）。

真实集群启动一个仅选 DeepSeek Harness 的云电脑后，在容器内自验：

```bash
# 1) dsh 由 harness 工作负载安装，且版本与 DSH_CLI_VERSION 一致（输出纯版本号）
dsh --version

# 2) 会话标识插件已安装（pnpm 由脚本引导安装；重跑幂等、退出码 0）
dsh plugin --profile acp why dsh-header-masq
command -v pnpm && pnpm --version

# 3) 注入文件已写入、权限正确
agent-gear harness prepare                        # 幂等：按 id 替换 patch 条目
cat ~/.dsh/profiles/acp/cordis.patch.yml          # llm-deepseek 禁用 + providers.zag + 默认路由 + insert header-masq
stat -c '%a' ~/.dsh/profiles/acp                 # 期望 700
stat -c '%a' ~/.dsh/.credentials.yaml            # 期望 600
dsh --dump-config | grep -n 'header-masq'        # 插件条目与四键配置（source/targets/fallbackToSessionId/debug）

# 4) 默认工作区已创建
test -d "${ZAG_DEFAULT_WORKSPACE:-/home/worker/workspace}" && echo workspace-ok

# 5) 日志不含模型 Key（secret 脱敏为 ***）
```

逐项核对：

- [ ] 镜像内 `command -v dsh` 无输出（未预装）；harness 初始化后 `dsh --version` 为固定值 `0.2.1-rc.2`
- [ ] `dsh-header-masq` 已安装到 acp profile；重跑 `dsh plugin --profile acp add Deliay/dsh-header-masq` 退出码 0 且不重复安装
- [ ] `~/.dsh/profiles/acp/cordis.patch.yml` 含 `llm-deepseek.disabled=true`、`providers.zag`（`apiKeyEnv` 引用而非明文 Key）与 `agent-default-model`/`acp` 默认路由
- [ ] `cordis.patch.yml` 含 insert 块 `header-masq`（`source=x-deepseek-harness-session-id`、`targets=[x-opencode-session]`、`fallbackToSessionId=true`、`debug=false`，不写 `hosts`）
- [ ] `.credentials.yaml` 为 `version: 1` + `refs.ZAG_MODEL_API_KEY`，权限 `600`；patch 目录 `700`
- [ ] 重复执行 `agent-gear harness prepare` 幂等（5 个受管条目按 id 替换、非我方条目与注释保留）
- [ ] `dsh --profile acp` 可拉起会话，模型选择仅 `ZAG` 组、默认选中，无内建官方渠道分组、无登录引导
- [ ] `ZAG_MODEL_API_KEY` 不出现在日志/错误/命令行；缺失 harness env 或 `dsh` 不可用时 init 失败 → 容器被强制注销

### 预制工作负载脚本手工验收（真实集群）

在挂载了「Docker」/「Node.js」/「.NET」/「Aspire」/「MongoDB」/「Playwright」工作负载的容器内，按初始化顺序逐项核对脚本产物：

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

# Playwright（依赖 Node.js，最后执行；默认仅 Chromium。下载来源为「Playwright」工作负载参数
# `playwright_download_host`——迁移 015 默认填入内网 playwright-proxy 地址，启动时可按次调整；
# 运行时 `PLAYWRIGHT_DOWNLOAD_HOST` 环境变量可覆盖且优先；脚本本身不内置默认值）
playwright --version
ls "$HOME/.cache/ms-playwright" | grep '^chromium-'   # 默认仅 Chromium（Firefox/WebKit 按需补装）
echo "$PLAYWRIGHT_DOWNLOAD_HOST"                      # 安装时已持久化到用户环境
```

pnpm 预装与工作负载安装口径（entrypoint `ensure_pnpm` + 迁移 017/018 脚本）：

```bash
# 首次启动（entrypoint，以 worker 用户）：npm 仅用于自举 pnpm，agent-gear 由 pnpm 安装
npm install -g pnpm@12.16.1
pnpm add -g agent-gear
# entrypoint 预装（新容器；固定版本 12.16.1）
pnpm --version                       # 12.16.1
echo "$PNPM_HOME"                    # /home/worker/.local/share/pnpm
echo "$PATH" | tr ':' '\n' | grep -F "$PNPM_HOME/bin"   # pnpm 12 全局 bin 必须在 PATH
login_shell_path=$(bash -lc 'echo "$PATH"'); case ":$login_shell_path:" in *":$PNPM_HOME/bin:"*) echo ok ;; *) echo missing ;; esac
# 交互 shell（pnpm setup 接线）：登录 worker 后
bash -lc 'command -v pnpm'
# worker 身份（run_as_worker 口径）可直接使用
sudo -u worker env HOME=/home/worker PNPM_HOME=/home/worker/.local/share/pnpm \
  PATH="/home/worker/.nvm/current/bin:/home/worker/.local/share/pnpm/bin:/home/worker/.local/share/pnpm:$PATH" pnpm --version
# 安装来源走内网代理（pnpm 读同一 ~/.npmrc）
pnpm config get registry             # https://nexus.internal.fffdan.com/repository/npm-proxy/
# 工作负载脚本安装行统一 `pnpm add -g`（OpenCode/Kimi Code/DeepSeek Harness/Playwright）；
# 存量容器（无 pnpm）由脚本内自举回退块 `npm install -g pnpm@12.16.1` 兜底（迁移 018 刷新）
# 预装失败仅告警：保活/agent-gear 链路正常，工作负载脚本回退块兜底（无阻断）
```

MongoDB（原生 apt 安装；成功判据仅 `mongod --version`，不拉起实例）：

```bash
# MongoDB（零参数零依赖；内网 Nexus GPG + apt 源）
mongod --version                                   # 输出版本信息（8.0.x）即安装成功
pgrep -a mongod                                    # 无输出：安装流程不拉起 mongod 实例（服务由用户按需自行启动）
cat /etc/apt/sources.list.d/mongodb-org-8.0.list   # 指向内网 nexus mongodb-apt-proxy（<codename>/mongodb-org/8.0）
ls -l /etc/apt/keyrings/mongodb-server-8.0.asc     # GPG keyring 存在且 world-readable
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
- [ ] 「MongoDB」安装后 `mongod --version` 输出 8.0.x 版本信息（安装成功硬校验；仅此判据）
- [ ] 安装流程**不拉起** mongod 实例：安装结束后 `pgrep -a mongod` 无输出（无 `--fork`/`nohup`/`runuser`/`systemctl`）；服务由用户按需自行启动
- [ ] 已安装环境重复执行「MongoDB」幂等：`command -v mongod` 短路秒回、不重复安装、不触碰既有源文件，用户已在运行的服务不受影响
- [ ] 安装源为需求指定内网地址：GPG 落 `/etc/apt/keyrings/mongodb-server-8.0.asc`，源文件 `/etc/apt/sources.list.d/mongodb-org-8.0.list` 指向 `https://nexus.internal.fffdan.com/repository/mongodb-apt-proxy`，全程不访问公网 `repo.mongodb.org`
- [ ] Nexus 不可达（`misc-cache/mongodb/server-8.0.asc` 或 `mongodb-apt-proxy`）时该工作负载记录失败与可读原因、可重试恢复，容器仍继续后续初始化并上线
- [ ] Playwright 脚本前置检查（`command -v node`/`npm`）通过，安装后 `playwright --version` 输出非空
- [ ] **默认仅 Chromium**：`$HOME/.cache/ms-playwright` 下存在 `chromium-*` 目录，默认不存在 `firefox-*`/`webkit-*`（按需补装）
- [ ] **下载来源默认已填且可达**：「Playwright」工作负载参数 `playwright_download_host` 默认已填内网代理地址 `https://nexus.internal.fffdan.com/repository/playwright-proxy/`；按默认值安装成功，全程走 `npm-proxy` + `playwright-proxy`、不触公网
- [ ] **地址已持久化到双用户环境**：root 与 worker 用户登录/交互 shell 均能读到 `PLAYWRIGHT_DOWNLOAD_HOST`（`/etc/profile.d/playwright.sh` + 各自 `~/.bashrc` 标记块）；两用户执行 `playwright install firefox` 补装走内网代理
- [ ] 清空 `playwright_download_host` 参数（且未提供 `PLAYWRIGHT_DOWNLOAD_HOST`）且 Playwright 尚未安装时：该工作负载**快速失败**并在执行记录中给出含正确地址形态的明确指引（容器仍继续后续初始化并上线）
- [ ] 下载地址不可达/Chromium 未就绪时该工作负载记录失败与日志，容器仍继续后续初始化并上线
- [ ] 新容器 `pnpm --version` 为 `12.16.1`；`PNPM_HOME/bin`（pnpm 12 全局 bin）与 `PNPM_HOME` 经 `WORKER_PATH` 与 `/etc/profile.d/pnpm.sh` 双入口生效
- [ ] 四个工作负载（OpenCode / Kimi Code / DeepSeek Harness / Playwright）安装行均为 `pnpm add -g`，来源走内网 npm 代理，结尾硬校验通过
- [ ] 存量容器（镜像无 pnpm）由脚本内自举回退块安装 pnpm 后安装成功
- [ ] 预装 pnpm 失败仅告警：`agent-gear` 保活/自更新链路正常，工作负载脚本回退块兜底
- [ ] Playwright 重复执行幂等（已安装直接校验通过、不重复下载）；工具与 Chromium 任一缺失时整体判失败

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
>
> **Playwright 安装来源**：默认来源由「Playwright」工作负载参数 `playwright_download_host` 提供——迁移 015
> 默认填入内网 `playwright-proxy` 地址 `https://nexus.internal.fffdan.com/repository/playwright-proxy/`，
> 启动时可按次调整；脚本本身**不内置默认值**，运行时 `PLAYWRIGHT_DOWNLOAD_HOST` 环境变量可覆盖且优先。
> 安装时解析到的地址持久注入 `/etc/profile.d/playwright.sh` 与 root/worker `~/.bashrc`；默认仅安装 Chromium，
> Firefox / WebKit 由用户按需补装并自动沿用该代理。清空参数且需安装时快速失败、打印含地址形态的指引并不影响
> 容器其余初始化。

> 工作负载脚本由 cloud-controller 经 Socket.IO 下发（不经 K8s env / Job manifest 注入），
> 因此变更后**需重新构建并推送 worker 镜像**（`entrypoint.sh` 的启动更新与版本不匹配自升级逻辑见下文「默认启动」）。

### 必须工作负载失败强制注销手工验收（真实集群）

前置：cloud-controller 已部署工作负载三期（支持 `workloadPlan[].required` 与必须失败裁决），worker 镜像内 `agent-gear` ≥ `2.4.0`（当前镜像为 2.11.x）。

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

1. `write_nvm_profile` / `write_pnpm_profile` 幂等写入登录 shell 接线；
2. `bootstrap_home` 以 worker 用户安装 nvm（内网 git 仓库）与 Node.js；`ensure_pnpm` 用 npm 自举
   `pnpm@12.16.1`；
3. 执行 `pnpm add -g agent-gear` 安装 / 更新到最新版（失败仅告警；设 `ZAG_SKIP_AGENT_GEAR_UPDATE=1` 可跳过）；
4. 以受监督方式运行 `agent-gear`（参数取自 `ZAG_SERVER_ENDPOINT` / `ZAG_CONTROLLER_KEY`）回连 cloud-controller。

> 云电脑（harness）容器额外注入标准连接凭据：`ZAG_HOST_ENDPOINT` + `ZAG_HOST_KEY`（controller-api），
> agent-gear 检测到后进入**双连接**模式（详见 `packages/agent-controller/AGENTS.md`）。`ZAG_CONTROLLER_KEY`
> 始终是 `/worker` 一次性 token，**不是**控制器 Key；`ZAG_HOST_KEY` 仅经握手 `auth.token` 携带，不进 URL。
> 普通 idle 容器不含 `ZAG_HOST_*`，行为与旧版完全一致。

> 入口**不**装配任何 docker shim、**不**调用 docker、也**不**启动 dockerd —— 容器内 docker 能力
> （CLI、镜像代理 shim、dockerd）全部由「Docker」工作负载的初始化脚本按需提供（工作负载四期）。

受监督运行的行为（版本门禁与自恢复，见 `docs/engineering/plan/20261017-feat-controller-version-requirement.md`）：

- `cloud-controller` 要求普通 worker 版本 `>=2.2.0` 且 major 为 `2`、harness（云电脑）worker 版本 `>=2.10.0`（含 `deepseek_harness` 的运行 `>=2.11.0`，header-masq 会话标识配置注入）；不兼容时返回 `error { code: "VERSION_MISMATCH", currentVersion, minimumVersion, supportedMajor }` 并断开，**不**将容器置为 online / initializing。
- 入口对 agent-gear 的 stderr 做流式扫描（实时透传、不落盘完整日志），仅在「非零退出 + 出现 `VERSION_MISMATCH` + 本轮未升级 + 未设置 `ZAG_SKIP_AGENT_GEAR_UPDATE=1`」时执行**一次** `pnpm add -g agent-gear`，升级成功后重启并重连。
- 安装失败、升级后仍不匹配、第二次不匹配、普通非零退出、正常退出均不会形成升级/重连循环；失败时容器非零退出，管理员可用既有强制销毁回收。
- 入口作为 PID 1 向 agent-gear / pnpm 子进程转发 `SIGTERM` / `SIGINT` 并等待退出；收到销毁信号后不再拉起控制器。
- 启动更新与版本不匹配恢复都受 `ZAG_SKIP_AGENT_GEAR_UPDATE=1` 控制（离线/排障出口）。

## 版本门禁与自升级自验

不需要真实 npm 网络或 dockerd 的静态/自动化自验：

```bash
cd deploy/images/worker
bash -n entrypoint.sh
bash entrypoint.test.sh
```

自动化用例覆盖：入口不装配 docker shim、不调用 docker/dockerd（T-EP0）、入口源码不含 `install_docker_shim`/`DOCKER_SHIM_PATH`/`HARBOR_PROXY` 残留（T-EP0a）、首轮旧版被拒 → 一次升级 → 重连成功（T-EP1）、安装失败（T-EP2）、升级后仍不兼容（T-EP3）、`ZAG_SKIP_AGENT_GEAR_UPDATE=1`（T-EP4）、普通错误/正常退出不升级（T-EP5/T-EP6）、`SIGTERM`/`SIGINT` 转发且不重启（T-EP7）、日志有界与透传（T-EP8）、单行 JSON 日志（T-EP12）、pnpm 预装幂等与失败容忍（T-EP13/T-EP14）、主目录自举（T-EP15 完整主目录 no-op / T-EP16 缺 nvm 时用自定义 git 仓库安装 / T-EP17 仅缺 node / T-EP18 下载失败与 fail-fast）、Dockerfile 不再构建期安装主目录工具链（T-EP19）。测试使用临时 PATH stub（假 `docker`/`dockerd`/`npm`/`pnpm`/`curl`/`agent-gear` 与假 `nvm.sh`），其中 `docker`/`dockerd` stub 仅作哨兵（入口一旦调用即落标记，T-EP0 断言标记为空），`curl`/`nvm` stub 只在临时目录内落地夹具产物，因此不会启动真实 dockerd、不访问网络、不触碰真实 `/home/worker`。

> **镜像升级要求**：云电脑双连接 / `harness prepare` 依赖 `agent-gear` ≥ `2.10.0`（harness 容器门禁），含 `deepseek_harness` 的运行需 ≥ `2.11.0`（`header-masq` 配置注入）；工作负载「必须」短路依赖 ≥ `2.4.0`，参数注入依赖 ≥ `2.3.0`。普通容器门禁常量 `MIN_WORKER_VERSION` 仍为 `2.2.0`（2.2.0 worker 仍能执行不带参数的脚本，且必须失败由服务端裁决、旧 worker 忽略 `required` 仍正确），但只有重建为 ≥ `2.10.0`（DeepSeek Harness 云电脑 ≥ `2.11.0`）的 worker 镜像才能承载 harness 云电脑。变更 `entrypoint.sh`/`Dockerfile` 后必须**重新构建并推送 worker 镜像**，并让新容器指向新 tag；已在运行的旧入口容器需强制销毁重建。

内网 K8s 受控验收（发布顺序见技术提案 §9.1）：

1. 构建并推送包含新 `entrypoint.sh` 的 worker 镜像，将新工作容器 `WORKER_IMAGE` 指向该镜像；
2. 部署带版本门禁的 `cloud-controller` 后，启动一个挂载初始化脚本的容器，确认日志出现 `VERSION_MISMATCH`（含当前/最低版本）→ `upgrading agent-gear after VERSION_MISMATCH` → `agent-gear upgraded: <version>` → 重连后初始化脚本被执行；
3. 对该容器执行强制销毁，确认即时完成（版本被拒期间从未写 `connectedAt`，不等待 post/shutdown 宽限）；
4. 用受控旧版 `agent-gear 2.1.0`（镜像内预装旧版且启动更新失败）验证一次自升级重连；再次模拟升级源不可用时确认容器非零退出且可强制销毁；
5. 核对日志不含 `ZAG_CONTROLLER_KEY`、token 或带凭据 URL。

> 已运行中的旧入口容器无法远程获得新恢复逻辑，需在门禁上线后**强制销毁重建一次**。


## 已知限制

- sysbox 为**节点级** runtime（`sysbox-runc`），集群节点需预装 sysbox，否则带 `runtimeClassName: sysbox-runc` 的 Pod 无法调度。集群未启用 sysbox 时可将 `RUNTIME_CLASS_NAME` 置空/改用其他 runtime。
- 镜像代理 shim 由「Docker」工作负载脚本在安装 CLI 后装配（`/usr/local/bin/docker`），会跳过 `--name/-e/-p/-v/--platform` 等带值选项的值，只对跳过选项后的首个位置参数（镜像引用）做代理改写，覆盖 `docker pull/run/create` 的常规用法；复杂 `docker build` 的 `FROM` 需在 Dockerfile 中直接书写代理地址（或使用 Harbor 代理前缀）。未选择「Docker」工作负载时容器内不存在该 shim。
- 工作容器基础环境不再预装 Docker / .NET，改由对应预制工作负载脚本在初始化阶段按需安装。安装源：Docker 由工作负载参数 `docker_apt_url` 提供（迁移 003 默认填入内网代理地址 `https://nexus.internal.fffdan.com/repository/docker-ce-apt`，可启动时按次调整；`DOCKER_APT_URL` 环境变量可覆盖且优先），脚本本身不内置默认值，清空参数且需安装时快速失败并给出指引；.NET 脚本经 **apt** 安装（内网 Ubuntu 源，必要时经 `DOTNET_APT_SOURCE`/`DOTNET_APT_KEY_URL` 追加 Microsoft feed 代理源，见上文「.NET（apt）相关构建参数」）；Aspire 由工作负载参数 `aspire_cli_url` 提供内网缓存代理安装包直链（迁移 004 默认填入 `https://nexus.internal.fffdan.com/repository/misc-cache/dotnet/aspire-cli-linux-x64.tar.gz`，可启动时按次调整；`ASPIRE_CLI_URL` 环境变量可覆盖且优先），脚本本身不内置默认值，清空且未安装时快速失败并给出指引。任一来源不可达时该工作负载记录失败并保留日志，容器仍继续后续初始化并上线（沿用一期失败策略）。

## worker 用户与保活自验（agent-gear 2.10.0）

镜像自 2.10.0 起：Node/npm/agent-gear 安装在 **worker 用户**的 per-user nvm（`/home/worker/.nvm`），
root 环境**没有** nodejs；PID 1 仍为 root，入口经 `setpriv` 以 worker 身份运行 agent-gear。

```bash
IMG=core.harbor.internal.fffdan.com/zero-tools/worker:dev

# 1) 身份与工具链归属
docker run --rm --entrypoint bash "$IMG" -lc 'id worker; ls -ld /home/worker/.nvm; command -v node || echo "root has no node (expected)"'
docker run --rm --entrypoint bash "$IMG" -lc 'runuser -l worker -c "node -v && npm -v && npm config get registry && agent-gear --version"'
docker run --rm --entrypoint bash "$IMG" -lc 'runuser -l worker -c "sudo -n true" && echo sudo-ok'

# 2) 保活：kill agent-gear 后容器不退出，退避 + 自更新后重新拉起
docker run -d --name worker-keepalive \
  -e ZAG_SERVER_ENDPOINT=wss://example.invalid/worker -e ZAG_CONTROLLER_KEY=dummy "$IMG"
docker exec worker-keepalive bash -lc 'pkill -f "agent-gear" || true'
docker logs --tail 20 worker-keepalive   # 期望出现 self-update then restarting
docker rm -f worker-keepalive
```

逐项核对：

- [ ] `id worker` 的 uid/gid 为 `1000`，`ls -ld /home/worker/.nvm` 属主为 `worker`
- [ ] root 侧 `command -v node` 无输出
- [ ] `runuser -l worker -c 'node -v'` 有输出；`agent-gear --version` 为 `2.11.x`
- [ ] `runuser -l worker -c 'sudo -n true'` 成功
- [ ] `kill`/`pkill` agent-gear 后容器不销毁，日志出现自更新 + 重启（退出码非 42）
- [ ] 服务端终止（`shutdown`/`unregistered`/`INVALID_TOKEN`）时 agent-gear 退出码 `42`，入口直接 0 退出、不重启
- [ ] worker 用户 `kill` PID 1 被拒（root 监督进程）

## 云存储主目录自举自验（`bootstrap_home` / `ZAG_STORAGE_HOME`）

镜像不再预装主目录工具链，因此**无论是否挂载云存储**，新容器首次启动都会执行自举：
`bootstrap_home` 按「产物存在且可执行」幂等安装 nvm（内网 git 仓库）与 Node.js，随后由
`ensure_pnpm` / `update_agent_gear` 补齐 pnpm 与 agent-gear。挂载云存储时 K8s 把 PVC 挂到
**`/home/worker`**，挂载内容完整（归档恢复）时自举为 no-op；不挂载云存储时 `/home/worker` 来自镜像层
（同样为空），自举行为一致。运行时依赖 `NVM_INSTALL_URL` / `NVM_SOURCE` / `NVM_INSTALL_VERSION` /
`NODE_VERSION` / `NVM_NODEJS_ORG_MIRROR` / `NPM_REGISTRY`（默认值在 `entrypoint.sh`，可用运行时环境变量覆盖）。

### 1) 空 `/home/worker` 起容器 → 自举成功

用 tmpfs 覆盖 `/home/worker`（等价于首次挂载空卷），保留 uid/gid 1000 可写：

```bash
IMG=core.harbor.internal.fffdan.com/zero-tools/worker:dev
docker run -d --name worker-empty-home \
  --tmpfs /home/worker:rw,exec,uid=1000,gid=1000 \
  -e ZAG_STORAGE_HOME=1 \
  -e ZAG_SERVER_ENDPOINT=wss://example.invalid/worker \
  -e ZAG_CONTROLLER_KEY=dummy "$IMG"
docker logs -f worker-empty-home
# 期望日志锚点（JSON msg）：
#   bootstrap_home: nvm not available, installing (NVM_INSTALL_URL=https://git.internal.fffdan.com/nvm-sh/nvm/raw/branch/master/install.sh, NVM_SOURCE=https://git.internal.fffdan.com/nvm-sh/nvm.git, ref=master)
#   bootstrap_home: nvm installed
#   bootstrap_home: node not available, installing Node.js 24
#   bootstrap_home: node installed (v24.x)
#   随后 pnpm installed / updating agent-gear via pnpm
docker exec worker-empty-home bash -lc \
  'runuser -l worker -c "node -v && npm -v && npm config get registry && pnpm --version && agent-gear --version"'
docker rm -f worker-empty-home
```

逐项核对：

- [ ] 空主目录下 `bootstrap_home` 依次命中 nvm → Node 两个锚点，`current` 软链由 `nvm which default` 重建
- [ ] `runuser -l worker` 下 `node -v` 符合 `NODE_VERSION`（默认 24.x）、`npm config get registry` 为内网 npm 代理
- [ ] `pnpm --version` 为 `12.16.1`、`agent-gear --version` 为运行期安装的最新版（pnpm/agent-gear 由既有链路补齐）
- [ ] `/home/worker/.nvm`、`/home/worker/.local` 属主为 `worker`（自举以 `run_as_worker` 身份执行，不产生 root 属主文件）
- [ ] 归档恢复场景（主目录已有完整环境）重跑：无 `bootstrap_home` 日志、无下载、无重复安装（no-op）
- [ ] **不挂载云存储**（去掉 `--tmpfs` 与 `ZAG_STORAGE_HOME=1`）的新容器同样完成 nvm → Node → pnpm → agent-gear 安装并正常回连（不因缺少云存储而失败）

### 2) `ZAG_STORAGE_HOME=1` 且下载源不可达 → 入口非零退出（fail-fast）

```bash
docker run --rm \
  --tmpfs /home/worker:rw,exec,uid=1000,gid=1000 \
  -e ZAG_STORAGE_HOME=1 \
  -e NVM_INSTALL_URL=https://unreachable.invalid/install.sh \
  -e ZAG_SERVER_ENDPOINT=wss://example.invalid/worker \
  -e ZAG_CONTROLLER_KEY=dummy \
  core.harbor.internal.fffdan.com/zero-tools/worker:dev; echo "exit=$?"
```

逐项核对：

- [ ] 日志出现 `bootstrap_home failed (... NVM_INSTALL_URL=...); ZAG_STORAGE_HOME=1 so exiting non-zero`
- [ ] `exit=1`，**不**出现 `connecting to cloud-controller` / agent-gear 拉起（不进入保活循环）
- [ ] cloud-controller 侧 Job 失败 → 创建云电脑失败 → 存储回滚到挂载前状态
- [ ] 同一场景去掉 `ZAG_STORAGE_HOME`（未挂载存储）时仅 `WARN: bootstrap_home failed ...`，入口继续保活

> 自举失败不会重试/退避：挂载存储时以非零退出交给 K8s Job 失败语义（`backoffLimit` 与创建失败回滚由
> cloud-controller 裁决），避免容器在残缺主目录上"假上线"。
