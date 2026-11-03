---
description: 测试环境 docker harbor 代理包装脚本误改写 --name 等带值选项的值，导致 Aspire 容器资源（Mongo/Redis/RabbitMQ/OTel）全部 FailedToStart、tests/api 集成测试链路不可用的问题调查报告——CLI 级最小复现 3/3 必现、bash -x argv 级证据、Aspire 运行日志 A/B 对照定位到 /usr/local/bin/docker 参数遍历缺陷
type: Permanent
---

# docker 包装脚本误改写 --name 的值 · 问题调查报告（2026-11-03）

> **状态**: ✅ **已复现、已定位（REPRODUCED & ROOT-CAUSED，2026-11-03）**——CLI 级最小复现 **3/3 必现**（`docker run -d --name <名字> redis:8.6` → `invalid container name`），`bash -x` 抓到包装脚本实际 exec 的改写后 argv；Aspire 运行日志 A/B 对照（同机同镜像：裸 PATH → 4 个容器资源全部 `FailedToStart`；PATH 前置修复版 shim → 4 个容器全部创建成功并持续运行）把根因钉死在 `/usr/local/bin/docker` 的参数遍历逻辑。修复脚本位于**测试环境镜像（非本仓库代码）**，落点归属与固化方案见第八节「待确认问题」。

## 关联文档

- 来源 Issue：[Deliay/z-agent-gear#409](https://github.com/Deliay/z-agent-gear/issues/409)（`start-BUG 修复工作流`，2026-11-02 创建）
- 历史同根因记录：`docs/engineering/acceptance/20261023-integration-release-acceptance-report.md` §1127（首次定位 + 当场修复，备份 `docker.bak-20261024`）、`docs/engineering/acceptance/20261028-integration-release-acceptance-report.md` §8.4/§9.3（复现 + 绕过）
- 受影响测试链路：`tests/api/AGENTS.md`（依赖 `aspire start` 拉起 MongoDB/Redis 后执行集成套件）
- 总分支：`bugfix/docker-wrapper-name-rewrite`（从 `origin/main` @ `869c4d19` 切出）
- 目标分支：`main`（人类问题描述未指定，按工作流默认）
- 调查报告路径：`docs/engineering/acceptance/20261103-docker-wrapper-name-rewrite-bug-investigation-report.md`
- 调研日期：2026-11-03

## 一、问题概述

**人类输入**（上游节点「输入问题描述」，源自 Issue #409）：测试环境的 `docker` 命令（`/usr/local/bin/docker`）不是原生 Docker CLI，而是一个 **harbor 代理包装脚本**（bash，最终 `exec /usr/bin/docker`），用途是把镜像引用重写为内网代理地址（`redis:8.6` → `core.harbor.internal.fffdan.com/docker-hub-proxy/redis:8.6`）。

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
| 问题脚本 | `/usr/local/bin/docker`（bash，1079 字节，mtime **2026-11-01 22:24**，root 拥有；非本仓库代码） |
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

1. **源码**：`/usr/local/bin/docker` 遍历逻辑（§一引用片段）——只判 `[ "${a#-}" = "$a" ]`，`--name test-redis` 中 `test-redis` 满足条件 → 被 `normalize_image` 改写。
2. **argv 轨迹**：`bash -x` 显示最终 `exec /usr/bin/docker create --name core.harbor.../repro-trace-1 redis:8.6`（§3.2）——改写发生在包装层，daemon 只是拒绝了非法名。
3. **最小复现**：`run/create --name <名字>` 3/3 必现 `invalid container name`（§3.1）；`--platform`/`-e` 同源错位（§3.3 C4/C5）。
4. **A/B 日志**：同机同镜像，裸 PATH 全 `FailedToStart` vs PATH 前置修复 shim 全部容器正常运行（§3.4）。
5. **历史同根因**：`20261023` 报告首次定位并当场修复（备份 `docker.bak-20261024`），`20261028` 报告复现并绕过——**本次为同一缺陷在镜像重建（脚本 mtime 2026-11-01 22:24）后回归**。

**为何是回归**：2026-10-24 曾修复过该 shim，但修复只落在当时环境；测试环境镜像于 2026-11-01 重新构建/覆盖，`/usr/local/bin/docker` 恢复为带缺陷版本 → 2026-11-02 的多次 Aspire 启动再次全红。**根因本质是「环境脚本缺陷 + 修复未固化进仓库/镜像」。**

**调用链**：`aspire start` → AppHost → DCP `run-controllers`/`ContainerReconciler` → `docker create --name <资源名> <镜像>`（PATH 解析到 `/usr/local/bin/docker` 包装脚本）→ 值被改写 → daemon `invalid container name` → 资源 `Starting -> FailedToStart` → 依赖容器的服务（agent-api 等）`Waiting` → `tests/api` 集成套件无法执行。

## 五、影响范围

| 维度 | 结论 |
|---|---|
| 受影响命令 | `docker pull / run / create` 中**任何「带值选项出现在镜像之前」**的形态：`--name/-n`、`-e/--env`、`-p/--publish`、`-v/--volume`、`--network`、`-w/--workdir`、`--entrypoint`、`--label`、`--platform`、`--restart` 等（脚本无跳过表，全中） |
| 不受影响 | ① `docker pull <镜像>`（无带值选项）；② `--xxx=value` 等号形态（整段以 `-` 开头透传）；③ `exec/ps/logs/rm` 等其它子命令（走 `*)` 分支原样透传）；④ 原生 `/usr/bin/docker` 直调 |
| 编排层 | Aspire/DCP 全部容器资源（mongodb/redis/rabbitmq/otel-collector）创建失败；项目进程资源不受影响 |
| 测试链路 | `tests/api` 集成套件（含 T-ST11/T-ST12/T-ST15 等 WebSocket 用例）**环境性不可用**；`tests/e2e` 依赖 `aspire start` 的实跑同样受阻 |
| 其它入口 | CI（GitHub Actions 原生 docker）不受影响；仅测试/开发环境镜像受影响 |
| 数据修复需求 | **无**——失败发生在容器创建前，未产生任何持久化脏数据；C5 类 env 污染也仅存在于失败命令的瞬时参数中 |
| 严重度 | 高（阻断集成测试主链路）+ **回归性质**（历史上已修过一次，未固化导致复发） |

## 六、修复方案与风险

> 脚本位于测试环境镜像（root 拥有，非本仓库代码），**本仓库无法直接提交该文件的修改**；方案分「环境侧根治」与「仓库侧防护」两层，具体落点待人类确认（§八）。

### 方案 A（环境侧根治，推荐主路径）

改造 `/usr/local/bin/docker` 参数遍历：

1. 维护**带值选项跳过表**（`--name/-n`、`-e/--env`、`-p/--publish`、`-v/--volume`、`--network`、`-w/--workdir`、`--entrypoint`、`-l/--label`、`--platform`、`--restart`、`--health-cmd` 等）：命中选项则连同其**下一个参数**一起原样透传，不进入归一化候选；
2. `--xxx=value`（含 `=`）形态整段透传（现状已正确，保持）；
3. 仅对**跳过表消费之后剩下的第一个位置参数**做 `normalize_image`；
4. 未知 flag：默认按「可能带值」保守处理（即下一个参数不归一化），宁可漏改不可错改——错改是 daemon 硬失败，漏改仅回退 docker.io 拉取。

**风险**：跳过表不全 → 某些选项仍错位（用 §七 用例集回归兜底）；「未知 flag 保守跳过」可能让镜像归一化漏掉（可接受，`normalize_image` 对已含域名的引用本就透传）。**落地方式待定**：直接改环境脚本（易再次被镜像重建覆盖，需镜像维护方同步）或把修复版脚本纳入本仓库（如 `deploy/` 或 `scripts/`）由镜像构建采纳——见 §八 #1。

### 方案 B（仓库侧防护，无论 A 是否落地都建议做）

1. **包装脚本行为回归测试**：仿 `deploy/images/worker/entrypoint.test.sh` 的 bash 测试风格，新增针对 harbor shim 的用例（`--name`/`-e`/`--platform`/等号形态/无选项 pull 五类断言），脚本缺失时自动 skip（CI 原生 docker 环境不受影响）；
2. **fail-fast 预检**：`tests/api/AGENTS.md` 增加环境预检步骤（或 `scripts/` 增加 preflight 脚本）：检测 `docker` 是否为 shim、并用 `docker create --name __preflight__ <小镜像>` 探测，失败时给出**指向本报告的明确报错**，避免下次再以「集成测试跑不起来」的表象浪费排查轮次；
3. **文档沉淀**：在 `tests/api/AGENTS.md` 记录「容器 FailedToStart → 先查 docker shim」的排障路径。

**风险**：预检命令本身需一个可拉取的小镜像（`redis:8.6` 已在本环境缓存）；bash 测试需避免在无 shim 环境误报（用「检测 shim 存在才执行」守卫）。

### 不做的事

- 不改 DCP/Aspire（上游行为正确，是被调用方被污染）；
- 不做数据修复（无脏数据，§五）；
- 不在本仓库复制整份环境脚本逻辑做「影子实现」（方案 A-落地方式若选入仓库，须以镜像构建单一事实来源为准，避免两份脚本漂移）。

## 七、回归测试计划

| # | 层级 | 用例 | 通过标准 |
|---|---|---|---|
| T1 | bash 单测 | `create --name <名字> <镜像>` 经 shim | argv 中 `--name` 值**未被改写**，镜像被归一化 |
| T2 | bash 单测 | `-e FOO=bar`、`--platform linux/amd64`、`-v /a:/b` 在镜像前 | 各值原样透传，仅镜像被归一化 |
| T3 | bash 单测 | `--name=<名字>` 等号形态 + `pull <镜像>` | 与现状一致（透传/归一化正确） |
| T4 | CLI 实测 | `docker run -d --name regression-$$ redis:8.6` | 创建成功，随后 `docker rm -f` 清理 |
| T5 | Aspire 集成 | `aspire start` → `aspire describe mongodb redis` | 均为 `Running`，**无** `FailedToStart` |
| T6 | 集成套件 | `tests/api`：`aspire start && aspire wait agent-api` → `pnpm test` | 套件可执行（含 T-ST11/T-ST12/T-ST15） |
| T7 | 回归防再犯 | 镜像重建后重跑 T1~T4 | 防止 shim 缺陷再次随镜像回归（对应 §四「为何是回归」） |

> 本轮（调查节点）交付 T1~T4 的用例设计与预期；**T4/T5/T6 实跑随修复节点执行**（本节点按人类指示跳过复现，Aspire 全链路复现未完成，见 §3.4 附注）。

## 八、待确认问题

1. **修复落点归属**：`/usr/local/bin/docker` 由测试环境镜像提供（root 拥有、非本仓库代码）。由**环境镜像维护方直接修**，还是**本仓库提交修复版 shim**（如 `scripts/` 或 `deploy/` 下）供镜像构建采纳？（影响方案 A 的落地方式与 §六风险条目；若入仓库，须明确镜像构建的取用路径避免双脚本漂移。）
2. **既有 workaround 是否固化**：`/home/worker/.local/bin/docker`（2026-11-02 创建的修复版）目前仅靠 `export PATH=$HOME/.local/bin:$PATH` 生效，**镜像重建即丢失**——是否随本次修复一并固化？
3. **历史备份处置**：`20261023` 报告提到的 `docker.bak-20261024` 在当前镜像中已不存在（镜像于 2026-11-01 重建），是否需要镜像维护方在新镜像中保留「原生 docker」回退路径？
4. **复现范围**：Aspire 全链路 e2e 复现本轮按人类指示跳过（CLI 级 3/3 复现 + A/B 日志证据已闭合）；修复后是否必须补跑 §七 T5/T6 才算验收通过（建议：是）。
5. **目标分支**：Issue 未指定目标分支，总 PR 按工作流默认指向 `main`；如人类另有指定需改。
