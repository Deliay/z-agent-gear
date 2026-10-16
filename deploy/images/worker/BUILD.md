# 默认工作容器镜像构建与自验（内网环境）

> 该镜像依赖内网 Nexus（Ubuntu/npm 代理）与 Harbor 镜像代理，**不在 GitHub CI 构建**（runner 不可达内网）。
> 请在可访问内网的机器上执行构建与自验。

## 构建

```bash
cd deploy/images/worker
docker build -t core.harbor.internal.fffdan.com/zero-tools/worker:dev .

# 内网地址变化时通过 --build-arg 覆盖
docker build \
  --build-arg UBUNTU_MIRROR=https://nexus.internal.fffdan.com/repository/ubuntu-proxy/ \
  --build-arg NPM_REGISTRY=https://nexus.internal.fffdan.com/repository/npm-proxy/ \
  --build-arg DOCKER_APT_URL=https://download.docker.com/linux/ubuntu \
  -t core.harbor.internal.fffdan.com/zero-tools/worker:dev .
```

构建完成后将镜像 `WORKER_IMAGE` 配置为 `core.harbor.internal.fffdan.com/zero-tools/worker:dev`（或推送后使用正式 tag）。

## 自验（PRD 功能点 3 验收标准）

```bash
docker run --rm -it --entrypoint bash \
  -e ZAG_SERVER_ENDPOINT=wss://example.invalid/worker \
  -e ZAG_CONTROLLER_KEY=dummy \
  core.harbor.internal.fffdan.com/zero-tools/worker:dev -lc '
    node -v && git --version && gh --version && docker buildx version && \
    agent-gear --version && \
    claude-agent-acp --help >/dev/null 2>&1 || true && \
    opencode --version || true && codex --version || true && \
    claude --version || true && gemini --version || true
  '
```

逐项核对：

- [ ] `node`、`git`、`gh`、`docker buildx` 可用
- [ ] 7 个 npm 全局包已安装：`agent-gear` `@agentclientprotocol/claude-agent-acp` `@agentclientprotocol/codex-acp` `@opencode/cli` `@openai/codex` `@anthropic-ai/claude-code` `@google/gemini-cli`
- [ ] 拉取 Docker Hub 镜像走代理：`docker pull ubuntu:24.04` 实际拉取 `core.harbor.internal.fffdan.com/docker-hub-proxy/ubuntu:24.04`
- [ ] 拉取 ghcr 镜像走代理：`docker pull ghcr.io/<owner>/<image>` 实际拉取 `core.harbor.internal.fffdan.com/ghcr/<owner>/<image>`

## 默认启动

容器默认 `ENTRYPOINT` 为 `entrypoint.sh`：启动容器内 `dockerd` → 装配镜像代理 shim → `exec agent-gear`（参数取自 `ZAG_SERVER_ENDPOINT` / `ZAG_CONTROLLER_KEY`），无需额外参数即回连 cloud-controller。

## 已知限制

- sysbox 为**节点级** runtime（`sysbox-runc`），集群节点需预装 sysbox，否则带 `runtimeClassName: sysbox-runc` 的 Pod 无法调度。集群未启用 sysbox 时可将 `RUNTIME_CLASS_NAME` 置空/改用其他 runtime。
- 镜像代理 shim 采用「首个非选项参数即镜像引用」的启发式改写，覆盖 `docker pull/run/create` 的常规用法；复杂 `docker build` 的 `FROM` 需在 Dockerfile 中直接书写代理地址（或使用 Harbor 代理前缀）。
