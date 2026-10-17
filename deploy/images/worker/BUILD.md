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
  --build-arg DOCKER_APT_URL=https://download.docker.com/linux/ubuntu \
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

## 自验（PRD 功能点 3 验收标准）

```bash
docker run --rm -it --entrypoint bash \
  -e ZAG_SERVER_ENDPOINT=wss://example.invalid/worker \
  -e ZAG_CONTROLLER_KEY=dummy \
  core.harbor.internal.fffdan.com/zero-tools/worker:dev -lc '
    nvm --version && nvm ls && \
    which node npm && node -v && npm -v && npm config get registry && \
    git --version && gh --version && docker buildx version && \
    agent-gear --version && \
    claude-agent-acp --help >/dev/null 2>&1 || true && \
    opencode --version || true && codex --version || true && \
    claude --version || true && gemini --version || true
  '
```

逐项核对：

- [ ] `node`、`git`、`gh`、`docker buildx` 可用；且 `which node` 指向 `/usr/local/nvm/current/bin/node`（已弃用 apt 的 node/npm）
- [ ] `nvm` 可用（登录 shell 通过 `/etc/profile.d/nvm.sh` 加载），`node -v` 版本符合 `NODE_VERSION`（默认 22.x）
- [ ] `npm config get registry` 为内网 npm 代理地址
- [ ] 7 个 npm 全局包已安装：`agent-gear` `@agentclientprotocol/claude-agent-acp` `@agentclientprotocol/codex-acp` `@opencode/cli` `@openai/codex` `@anthropic-ai/claude-code` `@google/gemini-cli`
- [ ] 拉取 Docker Hub 镜像走代理：`docker pull ubuntu:24.04` 实际拉取 `core.harbor.internal.fffdan.com/docker-hub-proxy/ubuntu:24.04`
- [ ] 拉取 ghcr 镜像走代理：`docker pull ghcr.io/<owner>/<image>` 实际拉取 `core.harbor.internal.fffdan.com/ghcr/<owner>/<image>`

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

- [ ] `agent-gear --version` ≥ `2.2.0`（支持工作负载执行协议；major 仍为 `2`，握手版本校验不受影响）
- [ ] `bash -c <script>` 可执行且 stdout/stderr 均被捕获（执行器合并捕获）
- [ ] 非零退出码被如实回报（`failed` + exitCode）；超时脚本会被强制终止（杀进程组）
- [ ] 单条输出超过 256 KiB 时按尾部截断

> 工作负载脚本由 cloud-controller 经 Socket.IO 下发（不经 K8s env / Job manifest 注入），
> 因此变更后**需重新构建并推送 worker 镜像**（`entrypoint.sh` 的 `npm install -g agent-gear` 更新逻辑不变）。

## 默认启动

容器默认 `ENTRYPOINT` 为 `entrypoint.sh`：启动容器内 `dockerd` → 装配镜像代理 shim → 执行 `npm install -g agent-gear` 更新到最新版（失败仅告警、回退镜像内预装版本；设 `ZAG_SKIP_AGENT_GEAR_UPDATE=1` 可跳过）→ `exec agent-gear`（参数取自 `ZAG_SERVER_ENDPOINT` / `ZAG_CONTROLLER_KEY`），无需额外参数即回连 cloud-controller。

## 已知限制

- sysbox 为**节点级** runtime（`sysbox-runc`），集群节点需预装 sysbox，否则带 `runtimeClassName: sysbox-runc` 的 Pod 无法调度。集群未启用 sysbox 时可将 `RUNTIME_CLASS_NAME` 置空/改用其他 runtime。
- 镜像代理 shim 采用「首个非选项参数即镜像引用」的启发式改写，覆盖 `docker pull/run/create` 的常规用法；复杂 `docker build` 的 `FROM` 需在 Dockerfile 中直接书写代理地址（或使用 Harbor 代理前缀）。
