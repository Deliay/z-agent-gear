---
description: Docker 预制工作负载脚本生成的 harbor 代理 shim 误改写 --name 等带值选项的值，导致 Aspire 容器资源（Mongo/Redis/RabbitMQ/OTel）全部 FailedToStart、tests/api 集成测试链路不可用的问题调查与修复报告——CLI 级最小复现 3/3 必现、bash -x argv 级证据、Aspire 运行日志 A/B 对照定位到 shim 参数遍历缺陷，已在仓库以 migration 020 修复
type: Permanent
---

# docker 包装脚本误改写 --name 的值 · 问题调查与修复报告（2026-11-03）

> **状态**: ✅ **已复现、已定位、已修复（REPRODUCED, ROOT-CAUSED & FIXED）**——CLI 级最小复现 **3/3 必现**（`docker run -d --name <名字> redis:8.6` → `invalid container name`），`bash -x` 抓到 shim 实际 exec 的改写后 argv；Aspire 运行日志 A/B 对照（同机同镜像：裸 PATH → 4 个容器资源全部 `FailedToStart`；PATH 前置修复版 shim → 4 个容器全部创建成功并持续运行）把根因钉死在 `/usr/local/bin/docker` 的参数遍历逻辑。
>
> **落点更正（2026-11-04）**：该 `/usr/local/bin/docker` **不是测试环境镜像自带、也不是外部运维脚本**，而是本仓库「Docker」预制工作负载初始化脚本在容器内生成的 harbor 代理 shim。脚本源头为 `servers/admin-api/src/migrations/003-docker-apt-source.ts`（v3）→ `012-worker-user-scripts.ts`（v4），由 `admin-api` 迁移写入 `cloudworkloads` 后在云主机初始化时执行。因此修复落点就在本仓库：新增 **migration 020** 将预置脚本刷新为 v5，修正 shim 的带值选项解析（见 §六/§九）。

## 关联文档

- 来源 Issue：[Deliay/z-agent-gear#409](https://github.com/Deliay/z-agent-gear/issues/409)（`start-BUG 修复工作流`，2026-11-02 创建）
- 历史同根因记录：`docs/engineering/acceptance/20261023-integration-release-acceptance-report.md` §1127（首次定位 + 当场修复，备份 `docker.bak-20261024`）、`docs/engineering/acceptance/20261028-integration-release-acceptance-report.md` §8.4/§9.3（复现 + 绕过）
- 受影响测试链路：`tests/api/AGENTS.md`（依赖 `aspire start` 拉起 MongoDB/Redis 后执行集成套件）
- 总分支：`bugfix/docker-wrapper-name-rewrite`（从 `origin/main` @ `869c4d19` 切出，修复提交前已合并最新 `origin/main`）
- 目标分支：`main`（人类问题描述未指定，按工作流默认）
- 调查报告路径：`docs/engineering/acceptance/20261103-docker-wrapper-name-rewrite-bug-investigation-report.md`
- 调研日期：2026-11-03；落点更正与修复：2026-11-04

## 一、问题概述

**人类输入**（上游节点「输入问题描述」，源自 Issue #409）：测试环境的 `docker` 命令（`/usr/local/bin/docker`）不是原生 Docker CLI，而是一个 **harbor 代理包装脚本**（bash，最终 `exec /usr/bin/docker`），用途是把镜像引用重写为内网代理地址（`redis:8.6` → `core.harbor.internal.fffdan.com/docker-hub-proxy/redis:8.6`）。

**来源更正**：该 shim 由本仓库「Docker」预制工作负载脚本生成——`admin-api` migration 003 写入 v3、012 写入带 sudo 的 v4，云主机初始化时以 `tee /usr/local/bin/docker` 落盘（root 拥有只是 `sudo` 执行的表象）。仓库内的事实来源：

- `servers/admin-api/src/migrations/003-docker-apt-source.ts` → `DOCKER_SCRIPT_V3`（shim heredoc 首次出现）
- `servers/admin-api/src/migrations/012-worker-user-scripts.ts` → `DOCKER_SCRIPT_V4`（叠加 sudo/worker 用户）
- 修复：`servers/admin-api/src/migrations/020-docker-shim-value-options.ts` → `DOCKER_SCRIPT_V5`

该脚本对 `pull|run|create` 的参数遍历只区分「以 `-` 开头的 flag」与「非 flag 参数」，**不识别需要接值的选项**，于是把 `--name` 的**值**当成镜像名改写：

```bash
for a in "$@"; do
  if [ "$normalized" -eq 0 ] && [ "${a#-}" = "$a" ]; then
    args+=("$(normalize_image "$a")"); normalized=1   # 第一个「非 - 开头」参数被当作镜像名重写
  else
    args+=("$a")
  fi
done
```

用户可见后果：

| 层次 | 期望 | 实际（本次调查结论） |
|---|---|---|
| `docker run/create --name <名字> <镜像>` | 容器以给定名字创建 | ❌ 名字被改写成 `core.harbor.../<名字>` → daemon 拒绝 `invalid container name` |
| Aspire/DCP 容器编排 | mongodb/redis/rabbitmq/otel-collector 正常启动 | ❌ 全部 `FailedToStart`，`docker ps -a` 无对应容器 |
| `tests/api` 集成测试 | 依赖 `aspire start` 拉起依赖后运行 | ❌ 链路前置条件不满足，套件无法执行 |
| `docker pull <镜像>`（无带值选项） | 正常拉取 | ✅ 不受影响（镜像本身经 harbor 代理可正常拉取） |

## 二、环境与版本

| 项 | 值 |
|---|---|
| 问题脚本 | `/usr/local/bin/docker`（bash，1079 字节，mtime **2026-11-01 22:24**，root 拥有）。**由本仓库 Docker 预制工作负载脚本生成**（`DOCKER_SCRIPT_V3`/`V4` 的 shim heredoc → `sudo tee /usr/local/bin/docker`），非镜像内置文件 |
| 真实 Docker CLI | `/usr/bin/docker`，Docker 29.9.2（build a82e528），daemon 正常 |
| harbor 代理 | `core.harbor.internal.fffdan.com`（`docker-hub-proxy` / `ghcr` 仓库） |
| Aspire CLI | 13.6.1+3751e615（`/usr/local/bin/aspire` → `~/.aspire/bin/aspire`） |
| DCP | `~/.nuget/packages/aspire.hosting.orchestration.linux-x64/13.6.3/tools/dcp`（`DockerCliOrchestrator`，经 docker CLI 编排） |
| 代码基线 | `origin/main` @ `869c4d19`（2026-11-03 fetch） |
| 调查分支 | `bugfix/docker-wrapper-name-rewrite`（从 `origin/main` 切出） |
| 既有 workaround | `/home/worker/.local/bin/docker`（修复版 shim，2026-11-02 11:42 创建，**仅靠 PATH 前置生效**，镜像重建即丢失） |
| 未能执行 | Aspire 全链路 e2e 复现（按人类指示跳过；另本机已有 worktree 386 的 `aspire run` 实例占用 dashboard/端口，本轮 `aspire start` 尝试以 AppHost exit 134 失败，详见 §3.4） |

## 三、复现步骤与结果

### 3.1 最小复现（CLI 级，稳定 3/3 必现）

```bash
# 用例 R1~R3：带值选项 --name 出现在镜像之前
docker run -d --name repro-1 redis:8.6
docker run -d --name repro-2 redis:8.6
docker run -d --name repro-3 redis:8.6
```

实际输出（3 次全部一致，`repro-1/2/3` 逐次复现）：

```
docker: Error response from daemon: invalid container name
(core.harbor.internal.fffdan.com/docker-hub-proxy/repro-1): only [a-zA-Z0-9][a-zA-Z0-9_.-] are allowed
```

`docker create` 同样中招：

```bash
docker create --name test-create-repro redis:8.6
# → Error response from daemon: invalid container name
#   (core.harbor.internal.fffdan.com/docker-hub-proxy/test-create-repro): only ...
```

**判定：稳定必现（3/3）。**

### 3.2 argv 级证据（`bash -x` 抓实际 exec 参数）

```bash
bash -x /usr/local/bin/docker create --name repro-trace-1 redis:8.6 2>&1
```

关键轨迹（包装脚本改写后、交给真实 docker 前的**最终 argv**）：

```
++ echo core.harbor.internal.fffdan.com/docker-hub-proxy/repro-trace-1   # ← --name 的值被改写
+ args+=("$a")
+ exec /usr/bin/docker create --name core.harbor.internal.fffdan.com/docker-hub-proxy/repro-trace-1 redis:8.6
Error response from daemon: invalid container name (core.harbor.internal.fffdan.com/docker-hub-proxy/repro-trace-1): only [a-zA-Z0-9][a-zA-Z0-9_.-] are allowed
```

注意改写链路的**双重错位**：被改写的是 `--name` 的值（→ 非法容器名），而**真正的镜像 `redis:8.6` 反而没被归一化**（一旦 `--name` 值侥幸合法，镜像还会走默认 docker.io 拉取）。

### 3.3 对照组（确认边界）

| 用例 | 命令 | 结果 |
|---|---|---|
| C1 无带值选项 | `docker pull redis:8.6` | ✅ 正常，归一为 `core.harbor.../docker-hub-proxy/redis:8.6` |
| C2 等号形态 | `docker create --name=eq-form-repro redis:8.6` | ✅ 成功（`--name=...` 以 `-` 开头，整段透传） |
| C3 镜像前无带值选项 | `docker run -d redis:8.6` | ✅ 成功 |
| C4 `--platform` 值被当镜像 | `docker pull --platform linux/amd64 definitely-not-exist-repro-xyz` | ❌ `"core.harbor.internal.fffdan.com" is an invalid OS component of "core.harbor.internal.fffdan.com/docker-hub-proxy/linux/amd64"` |
| C5 `-e` 值被当镜像（静默污染） | `docker run -e FOO=bar definitely-not-exist-repro-xyz` | ❌ `-e` 的值被改写为 `core.harbor.../FOO=bar`（env 名被污染，**无任何告警**），真实镜像反而未归一化 |

C4/C5 证明缺陷**不止于 `--name`**：所有「带值选项出现在镜像之前」的形态都会错位，且 C5 属于**静默数据污染**（比直接报错更危险）。

### 3.4 Aspire 层证据（历史运行日志 A/B 对照，本机日志实证）

**A 组（裸 PATH，包装脚本生效）——容器资源全部 FailedToStart：**

- `~/.aspire/logs/cli_20261102T113722093_detach-child_*.log`（2026-11-02 11:37）：
  ```
  Resource mongodb/mongodb-kxdrymue changed state: Starting -> FailedToStart
  Resource redis/redis-wjcxwmey changed state: Starting -> FailedToStart
  ```
- `~/.aspire/logs/cli_20261102T144527657_detach-child_*.log`（2026-11-02 14:45）：
  ```
  Resource mongodb/mongodb-fqvqwuzb changed state: Starting -> FailedToStart
  Resource redis/redis-vxbebmqt changed state: Starting -> FailedToStart
  Resource rabbitmq/rabbitmq-tabkkmak changed state: Starting -> FailedToStart
  Resource otel-collector/otel-collector-awevqpgc changed state: Starting -> FailedToStart
  ```
  （该时段 `docker ps -a` 中无对应容器，与 Issue 描述一致。）

**B 组（PATH 前置修复版 shim）——同机同镜像，4 个容器全部创建成功：**

- `~/.local/share/opencode/log/opencode.log` 2026-11-02 11:43/11:54 两次执行 `export PATH=$HOME/.local/bin:$PATH && aspire stop && aspire start`（修复版 shim 于 11:42:58 落盘 `/home/worker/.local/bin/docker`）；
- 随后 `docker inspect` 显示 4 个容器均由 DCP 创建且**持续运行至今**：
  ```
  mongodb-ghzpgegk   core.harbor.../mongo:7                    Up 14 hours（Created 2026-11-02T11:54:42Z，带 com.microsoft.developer.usvc-dev.* 标签）
  redis-skxnujsb     core.harbor.../library/redis:8.6          Up 14 hours
  rabbitmq-fuxsrqrq  core.harbor.../library/rabbitmq:4.3       Up 14 hours
  otel-collector-crestbyz core.harbor.../otel/...:latest       Up 14 hours
  ```

**A/B 结论**：唯一变量是 `docker` 包装脚本是否正确跳过带值选项——A 组全失败、B 组全成功，因果链闭合。

**3.4 附注（如实记录）**：本轮尝试在当前 worktree 重新执行 `aspire start` 做在线 e2e 复现时，AppHost 以 exit 134 失败（dashboard service host 启动异常，本机已有 worktree 386 的 `aspire run` 实例 PID 133968 占用端口/lease）。按人类指示**跳过问题复现**，不再重试；上述 CLI 级 3/3 复现 + argv 轨迹 + A/B 日志证据已足以支撑根因结论。修复后按 §七 补跑全链路验证。

### 3.5 dcp 调用形态（旁证）

- `dcp` 二进制内含 `DockerCliOrchestrator`（`CreateContainer`/`PullImage` 等均经 docker CLI 子进程）与 `--name` flag 字面量，与「DCP 调 `docker create --name <资源名> <镜像>`」的形态吻合；
- 与 `20261023` 报告的 DCP `ContainerReconciler` 日志实证（`docker create --name mongodb-jaejfbwk <image>` → `invalid container name`）一致。

## 四、根因分析（含证据）

**根因（单点）**：`/usr/local/bin/docker` 对 `pull|run|create` 的参数归一化采用「第一个不以 `-` 开头的参数即镜像」的启发式，**缺少带值选项（value-taking option）跳过表**，也未处理「带值选项的值不以 `-` 开头」这一常态。

**证据链**：

1. **源码**：本仓库 `DOCKER_SCRIPT_V3`/`V4` 的 shim heredoc（§一引用片段）——只判 `[ "${a#-}" = "$a" ]`，`--name test-redis` 中 `test-redis` 满足条件 → 被 `normalize_image` 改写；容器内 `/usr/local/bin/docker` 即由该 heredoc 原样落盘。
2. **argv 轨迹**：`bash -x` 显示最终 `exec /usr/bin/docker create --name core.harbor.../repro-trace-1 redis:8.6`（§3.2）——改写发生在包装层，daemon 只是拒绝了非法名。
3. **最小复现**：`run/create --name <名字>` 3/3 必现 `invalid container name`（§3.1）；`--platform`/`-e` 同源错位（§3.3 C4/C5）。
4. **A/B 日志**：同机同镜像，裸 PATH 全 `FailedToStart` vs PATH 前置修复 shim 全部容器正常运行（§3.4）。
5. **历史同根因**：`20261023` 报告首次定位并当场修复（备份 `docker.bak-20261024`），`20261028` 报告复现并绕过——**本次为同一缺陷在 Docker 工作负载重新初始化后回归**。

**为何是回归**：2026-10-24 曾修复过该 shim，但只改了当时容器内的 `/usr/local/bin/docker`，**仓库里的 shim 源头（migration 003/012）未同步修复**；测试环境镜像于 2026-11-01 重建、Docker 工作负载再次执行初始化脚本，缺陷版本被重新落盘 → 2026-11-02 的多次 Aspire 启动再次全红。**根因本质是「仓库内 shim 生成逻辑缺陷 + 历史修复只落在运行环境、未固化进仓库」。**

**调用链**：`aspire start` → AppHost → DCP `run-controllers`/`ContainerReconciler` → `docker create --name <资源名> <镜像>`（PATH 解析到 `/usr/local/bin/docker` 包装脚本）→ 值被改写 → daemon `invalid container name` → 资源 `Starting -> FailedToStart` → 依赖容器的服务（agent-api 等）`Waiting` → `tests/api` 集成套件无法执行。

## 五、影响范围

| 维度 | 结论 |
|---|---|
| 受影响命令 | `docker pull / run / create` 中**任何「带值选项出现在镜像之前」**的形态：`--name/-n`、`-e/--env`、`-p/--publish`、`-v/--volume`、`--network`、`-w/--workdir`、`--entrypoint`、`--label`、`--platform`、`--restart` 等（脚本无跳过表，全中） |
| 不受影响 | ① `docker pull <镜像>`（无带值选项）；② `--xxx=value` 等号形态（整段以 `-` 开头透传）；③ `exec/ps/logs/rm` 等其它子命令（走 `*)` 分支原样透传）；④ 原生 `/usr/bin/docker` 直调 |
| 编排层 | Aspire/DCP 全部容器资源（mongodb/redis/rabbitmq/otel-collector）创建失败；项目进程资源不受影响 |
| 测试链路 | `tests/api` 集成套件（含 T-ST11/T-ST12/T-ST15 等 WebSocket 用例）**环境性不可用**；`tests/e2e` 依赖 `aspire start` 的实跑同样受阻 |
| 其它入口 | CI（GitHub Actions 原生 docker）不受影响；**选择「Docker」工作负载的云主机/开发机**会生成带缺陷 shim（源头在本仓库工作负载脚本，非 worker 镜像本身） |
| 数据修复需求 | **无**——失败发生在容器创建前，未产生任何持久化脏数据；C5 类 env 污染也仅存在于失败命令的瞬时参数中 |
| 严重度 | 高（阻断集成测试主链路）+ **回归性质**（历史上已修过一次，但只改运行环境、未修仓库源头） |

## 六、修复方案与落地

> **落点更正**：shim 的源头在本仓库「Docker」预制工作负载脚本（migration 003/012），因此不需要环境镜像维护方同步，也不需要复制一份环境侧脚本。修复直接进入迁移体系。

### 6.1 已实施：migration 020（v5）

新增 `servers/admin-api/src/migrations/020-docker-shim-value-options.ts`：

- 以 `DOCKER_SCRIPT_V4` 为基线，定点替换 shim 的参数遍历块，生成 `DOCKER_SCRIPT_V5`（历史版本常量保持字节不变，供迁移匹配）；
- 迁移按 `presetKey='docker'`（回退精确 `name='Docker'`）定位，库内脚本字节等于 V1/V2/V3/V4 才刷新为 V5；已是 V5 则 no-op；管理员定制脚本 `warn` 跳过；管理员删除的预置项不重建；
- 已注册到 `servers/admin-api/src/index.ts` 的启动迁移列表，随 admin-api 启动自动执行。

**生效路径**：admin-api 启动 → `admin_migrations` 执行 020 → `cloudworkloads.initScript` 更新为 v5 → 云主机下次执行「Docker」工作负载初始化时 `tee /usr/local/bin/docker` 落盘 v5。**已经落盘的坏 shim 需要重跑该工作负载（或重建/恢复云主机）才会被覆盖**；本修复不依赖对运行中容器做热替换。

### 6.2 v5 参数解析规则

- `--opt=value`（含 `=`）整段透传；
- 长选项命中 `VALUE_LONG_OPTS`（`--name/-e/--env/-p/--publish/-v/--volume/--platform/--network/-w/--workdir/--entrypoint/--label/--restart/--health-*` 等）时，连同下一个参数一起透传；
- 短选项按字符簇解析：`-e FOO=bar` 跳过下一参数；`-eFOO=bar`、`-p8080:80`、`-v/a:/b` 整段透传；`-it`/`-d` 等布尔簇不受影响；
- `pull` 单独处理：`-a/--all-tags`、`-q/--quiet` 是布尔，仅 `--platform` 跳过其值；
- 未知长选项按**无值布尔**处理——宁可漏归一化（回退 docker.io 拉取），也不吞掉镜像/命令参数；
- `--` 之后全部视为位置参数；
- 只对跳过选项后的**第一个位置参数**调用 `normalize_image`，其后的命令/参数不再改写。

### 6.3 回归测试（已落地）

`servers/admin-api/src/migrations/020-docker-shim-value-options.test.ts`（15 个用例）覆盖：

- 迁移口径：V1/V2/V3/V4 → V5 刷新、V5 幂等、管理员定制跳过、已删除不重建；
- shim argv 级行为：`create/run --name` 值不被改写、`-e/-p/-v/--platform` 值透传、等号形态与短选项粘连、`pull -a/-q/--platform`、未知长选项、其它子命令透传；
- 脚本可被 `bash -n` 解析，安装/启动/校验锚点保持不变。

### 6.4 风险与边界

- **跳过表不全**：未来 Docker 新增「带值长选项」若未及时补表，其值可能仍被误当镜像；但未知长选项按布尔处理，不会进一步吞掉镜像后的命令参数，且回归用例可快速扩展；
- **存量运行中容器**：旧 shim 仍驻留，直到重跑 Docker 工作负载/重建容器；这是迁移式修复的固有生效延迟，不是新缺陷；
- **不改 DCP/Aspire**：上游行为正确，问题在被调用的 shim；
- **不做数据修复**：失败发生在容器创建前，无持久化脏数据。

## 七、回归测试计划

| # | 层级 | 用例 | 通过标准 | 状态 |
|---|---|---|---|---|
| T1 | bash 单测 | `create --name <名字> <镜像>` 经 shim | argv 中 `--name` 值**未被改写**，镜像被归一化 | ✅ migration 020 单测 |
| T2 | bash 单测 | `-e FOO=bar`、`--platform linux/amd64`、`-v /a:/b` 在镜像前 | 各值原样透传，仅镜像被归一化 | ✅ migration 020 单测 |
| T3 | bash 单测 | `--name=<名字>` 等号形态 + `pull <镜像>` | 透传/归一化正确 | ✅ migration 020 单测 |
| T4 | CLI 实测 | `docker run -d --name regression-$$ redis:8.6` | 创建成功，随后 `docker rm -f` 清理 | ⏸ 本轮执行环境无 docker/daemon，随部署环境验收补跑 |
| T5 | Aspire 集成 | `aspire start` → `aspire describe mongodb redis` | 均为 `Running`，**无** `FailedToStart` | ⏸ 同上 |
| T6 | 集成套件 | `tests/api`：`aspire start && aspire wait agent-api` → `pnpm test` | 套件可执行（含 T-ST11/T-ST12/T-ST15） | ⏸ 同上 |
| T7 | 回归防再犯 | 工作负载重新初始化后重跑 T1~T4 | shim 缺陷不再随初始化回归 | ✅ 源头修复 + 迁移单测；T4 随 T5/T6 补跑 |

> T1~T3 已由 `020-docker-shim-value-options.test.ts` 以 argv 级断言实跑通过；T4~T6 需要真实 Docker daemon / Aspire 环境，本轮执行环境不具备，未虚报结果。

## 八、已确认事项（原「待确认问题」）

1. **修复落点归属**：已确认 shim 由本仓库 Docker 预制工作负载脚本生成，直接在本仓库修（migration 020），无需环境镜像维护方另行同步。
2. **既有 workaround**：`/home/worker/.local/bin/docker` 只是临时 PATH 绕过，不再作为交付物；migration 020 落地后由工作负载重新初始化覆盖正式 shim。
3. **历史备份处置**：`docker.bak-20261024` 不再是必要路径；原生 CLI 始终是 `/usr/bin/docker`，shim 仅做参数转发。
4. **复现与验收范围**：Aspire 全链路本轮未实跑（环境限制），部署到具备 Docker daemon 的环境后需补跑 T4~T6 完成端到端验收。
5. **目标分支**：PR 目标为 `main`；分支已合并最新 `origin/main`，沿用 `bugfix/docker-wrapper-name-rewrite`。

## 九、修复记录

| 项 | 内容 |
|---|---|
| 修复文件 | `servers/admin-api/src/migrations/020-docker-shim-value-options.ts`、`020-docker-shim-value-options.test.ts` |
| 注册点 | `servers/admin-api/src/index.ts` 启动迁移列表 |
| 文档同步 | `deploy/images/worker/BUILD.md`「已知限制」改为「跳过带值选项后归一化首个位置参数」 |
| 历史常量 | V1~V4 保持字节不变，V5 由 V4 定点替换生成，避免破坏迁移的字节匹配口径 |
| 验证 | `vitest run src/migrations/020-docker-shim-value-options.test.ts`：15 passed（含 V1~V4 刷新、V5 幂等、admin 定制跳过、shim argv 行为、`bash -n`） |
