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
    agent-gear --version && \
    claude-agent-acp --help >/dev/null 2>&1 || true && \
    opencode --version || true && codex --version || true && \
    claude --version || true && gemini --version || true
  '
```

逐项核对：

- [ ] `node`、`git`、`gh` 可用；且 `which node` 指向 `/usr/local/nvm/current/bin/node`（已弃用 apt 的 node/npm）
- [ ] `nvm` 可用（登录 shell 通过 `/etc/profile.d/nvm.sh` 加载），`node -v` 版本符合 `NODE_VERSION`（默认 22.x）
- [ ] `npm config get registry` 为内网 npm 代理地址，且运行时 `NPM_REGISTRY` 环境变量已固化（`echo "$NPM_REGISTRY"`，供 Node.js 工作负载脚本读取）
- [ ] 7 个 npm 全局包已安装：`agent-gear` `@agentclientprotocol/claude-agent-acp` `@agentclientprotocol/codex-acp` `@opencode/cli` `@openai/codex` `@anthropic-ai/claude-code` `@google/gemini-cli`
- [ ] `agent-gear --version` ≥ `2.3.0`（工作负载参数注入能力；见下方「工作负载执行自验」）
- [ ] **未选择「Docker」工作负载时容器内不存在 docker 能力**：`command -v docker` 无输出、`command -v dockerd` 无输出、`pgrep -a dockerd` 无输出、`[ ! -e /usr/local/bin/docker ]`
- [ ] **未选择「.NET」/「Aspire」时容器内不存在 .NET 能力**：`command -v dotnet` 无输出

> Docker（`docker buildx`、镜像代理拉取）与 .NET / Aspire 能力属工作负载范畴，验收见下方
> 「预制工作负载脚本手工验收（真实集群）」。

### 镜像瘦身静态校验（工作负载四期）

Dockerfile / entrypoint 中不得再出现 Docker 预装或 shim 装配的残留（对应实现计划 裁决 9）：

```bash
cd deploy/images/worker
grep -nE 'docker-ce|docker-buildx|containerd\.io|DOCKER_APT_URL|docker\.asc|docker\.list' Dockerfile && exit 1 || true
grep -nE 'iptables|iproute2|fuse-overlayfs|libseccomp2|conntrack' Dockerfile && exit 1 || true
grep -nE 'DOTNET_|ASPIRE_' Dockerfile && exit 1 || true
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
    bash -c "echo workload-ok" && \
    bash -c "echo out; echo err 1>&2; exit 7" ; echo "exit=$?"
  '
```

逐项核对：

- [ ] `agent-gear --version` ≥ `2.3.0`（支持工作负载**参数注入**协议；注册门禁要求 `>=2.2.0` 且 major 为 `2`，低于最低版本会被 `VERSION_MISMATCH` 拒绝）
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

# .NET（LTS）
dotnet --info
dotnet --list-sdks

# Aspire（依赖 Docker + .NET，最后执行；成功判据为 CLI 可执行）
aspire --version
```

逐项核对：

- [ ] 未选择「Docker」工作负载时容器内**没有** docker/dockerd（入口不装配 shim、不启动 dockerd，全部由 Docker 脚本负责）；选择后 `docker info` 可用
- [ ] 选择「Docker」后 `docker version`、`docker buildx version` 均成功；重复执行 Docker 脚本幂等收敛（不重复安装/不重复启动）
- [ ] 拉取 Docker Hub 镜像走代理：`docker pull ubuntu:24.04` 实际拉取 `core.harbor.internal.fffdan.com/docker-hub-proxy/ubuntu:24.04`
- [ ] 拉取 ghcr 镜像走代理：`docker pull ghcr.io/<owner>/<image>` 实际拉取 `core.harbor.internal.fffdan.com/ghcr/<owner>/<image>`
- [ ] Docker 安装源不可达时该工作负载记录失败与日志，容器仍继续后续初始化并上线
- [ ] Node.js 脚本按 `version` 参数安装/切换版本、按 `package_manager` 多选安装包管理器，`npm config get registry` 为内网代理
- [ ] .NET 脚本安装 LTS SDK，`dotnet --list-sdks` 非空
- [ ] Aspire 脚本在前置依赖就绪后安装 CLI，`aspire --version` 输出非空（不能仅以安装脚本返回 0 判成功）

> 「Docker」工作负载脚本运行期默认经**内网 Nexus docker-ce 代理**安装
> （`DOCKER_APT_URL` 默认 `https://nexus.internal.fffdan.com/repository/docker-ce-proxy/linux/ubuntu/`，
> 与镜像内其它内网源同一套 Nexus 代理；可用同名环境变量覆盖，**不回退公网**）。
> 安装包列表为 `docker-ce docker-ce-cli docker-buildx-plugin containerd.io`：其中 `docker-ce` 提供
> `dockerd`（守护进程），`docker-ce-cli` 仅提供客户端，四者缺一不可。若内网实际仓库名不同，
> 请在容器环境或脚本内覆盖 `DOCKER_APT_URL`。

> 工作负载脚本由 cloud-controller 经 Socket.IO 下发（不经 K8s env / Job manifest 注入），
> 因此变更后**需重新构建并推送 worker 镜像**（`entrypoint.sh` 的启动更新与版本不匹配自升级逻辑见下文「默认启动」）。

## 默认启动

容器默认 `ENTRYPOINT` 为 `entrypoint.sh`，启动流程：

1. 执行 `npm install -g agent-gear` 更新到最新版（失败仅告警、回退镜像内预装版本；设 `ZAG_SKIP_AGENT_GEAR_UPDATE=1` 可跳过）；
2. 以受监督方式运行 `agent-gear`（参数取自 `ZAG_SERVER_ENDPOINT` / `ZAG_CONTROLLER_KEY`）回连 cloud-controller。

> 入口**不**装配任何 docker shim、**不**调用 docker、也**不**启动 dockerd —— 容器内 docker 能力
> （CLI、镜像代理 shim、dockerd）全部由「Docker」工作负载的初始化脚本按需提供（工作负载四期）。

受监督运行的行为（版本门禁与自恢复，见 `docs/engineering/plan/20261017-feat-controller-version-requirement.md`）：

- `cloud-controller` 要求 worker 版本 `>=2.2.0` 且 major 为 `2`；不兼容时返回 `error { code: "VERSION_MISMATCH", currentVersion, minimumVersion, supportedMajor }` 并断开，**不**将容器置为 online / initializing。
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

> **镜像升级要求**：工作负载参数注入依赖 `agent-gear` ≥ `2.3.0`。`cloud-controller` 的门禁常量 `MIN_WORKER_VERSION` 仍为 `2.2.0`（2.2.0 worker 仍能执行不带参数的脚本），但只有重建为 ≥ `2.3.0` 的 worker 镜像才具备 `WORKLOAD_PARAMS` / `WORKLOAD_PARAM_*` 注入能力。变更 `entrypoint.sh`/`Dockerfile` 后必须**重新构建并推送 worker 镜像**，并让新容器指向新 tag；已在运行的旧入口容器需强制销毁重建。

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
- 工作容器基础环境不再预装 Docker / .NET，改由对应预制工作负载脚本在初始化阶段按需安装。安装源（`DOCKER_APT_URL` / `DOTNET_INSTALL_URL` 等）在内网不可达时该工作负载记录失败并保留日志，容器仍继续后续初始化并上线（沿用一期失败策略）。
