---
description: 云端工作容器控制器版本门禁与自升级实现计划：从技术提案拆解出的契约先行分阶段任务（cloud-controller 完整版本门禁与 VERSION_MISMATCH 载荷扩展、worker entrypoint 旧版自升级重连、销毁副作用隔离与入口脚本测试）与测试覆盖计划
type: Permanent
---

# 云端工作容器控制器版本门禁与自升级 - 实现计划

**关联 Proposal**: `proposals/20261017-feat-controller-version-requirement.md`（v1.0）
**关联 PRD**: `docs/product/draft/20261017-controller-version-requirement.md`（v1.0）
**feat-branch**: `feat/controller-version-requirement`（需求总分支，需求总 PR #218）
**开发分支**: `feat/controller-version-requirement-impl`（基于 `feat/controller-version-requirement` 切出，覆盖 `servers/cloud-controller` 与 `deploy/images/worker`，完成后 PR 回需求总分支）
**创建日期**: 2026-10-17
**计划版本**: v1.0

## 实现顺序

```
Phase 1: 契约先行（contracts/cloud-controller-websocket.md：最低版本规则 + VERSION_MISMATCH 载荷扩展 + 拒绝副作用约束）
  └── Phase 2: cloud-controller 版本门禁（services/worker-version.ts 纯函数 + socketio-gateway 注册门禁与日志）
        └── Phase 3: 销毁副作用锚定（container-service.test.ts：未兼容注册容器 destroy 不等待）
              └── Phase 4: worker entrypoint 监督恢复（entrypoint.sh 一次自升级重连 + entrypoint.test.sh + BUILD.md）
                    └── Phase 5: 文档收口 + 全量回归 + PR 回需求总分支
```

依赖说明：Phase 1 契约是全部实现的输入，须先独立提交（`docs(contracts): ...`）。Phase 2 只依赖 Phase 1；Phase 3 是对既有 destroy 语义（`connectedAt === null` 跳过优雅停机）的测试锚定，可与 Phase 2 并行但应在 Phase 2 合并前完成（门禁上线后 `2.1.0` 即走该路径）；Phase 4 仅依赖 Phase 1 的错误码/载荷约定（入口只解析稳定错误码 `VERSION_MISMATCH`），可与 Phase 2/3 并行开发，联调依赖 Phase 2。Phase 5 收口。

开发模式采用 TDD（红-绿-重构）：每个 Phase 先写测试（RED）再实现（GREEN）。编码前加载 `docs/engineering/common-rules.md`、`backend-rules.md`（后端 Phase）与 `servers/cloud-controller/AGENTS.md`（Phase 2/3）、`deploy/images/worker/BUILD.md`（Phase 4），并遵循各子项目 `AGENTS.md`。

### 关键约束（提案 §5.2/§6.1，实现期不得回退）

- **契约先行**：`contracts/cloud-controller-websocket.md` 先于实现独立提交，字段与提案 §3.1 逐项对齐。
- **门禁先于副作用**：版本校验必须位于 `markOnline` / `markInitializing` / `heartbeatTracker.record` / `hasInitScripts` / `startInit` 之前；拒绝路径只 `emit('error', …)` + `socket.disconnect(true)`，不写 `socket.data.registered`。
- **最低版本是代码常量**：`MIN_WORKER_VERSION = '2.2.0'`、`SUPPORTED_MAJOR = 2` 随服务端与契约发布，不新增环境变量（提案 §6.1）。
- **不新增 semver 依赖**：本地严格三段数字解析与数字比较（`2.10.0` > `2.2.0`，禁止字符串比较）。
- **自升级在 worker 入口，不在 CLI 进程内**：旧 `2.1.0` 不含新代码；`packages/agent-controller` 本期零改动。
- **自升级有界**：单次容器运行最多一次 `npm install -g agent-gear --no-fund --no-audit`；失败、二次版本拒绝、`ZAG_SKIP_AGENT_GEAR_UPDATE=1` 均收敛为非零退出，不形成升级/重连循环。
- **信号语义不变**：entrypoint 作为 PID 1 必须向 agent-gear 子进程转发 `SIGTERM`/`SIGINT` 并等待退出；销毁信号后不得重启；dockerd 启动与 docker shim 行为不变。
- **日志脱敏**：版本与错误日志不含 token、key、带凭据 URL；`currentVersion` 写日志前去控制字符并截断（提案 §5.2 实现点 4）。
- **不扩展范围**：不改本地 `controller-api` 版本规则、不改 agent-gear 协议、不新增 GraphQL/REST/DB/前端页面、不给管理员绕过开关。
- **测试纪律**：新增 TypeScript 代码覆盖率 ≥ 80%；入口脚本测试为纯 Bash + PATH stub，不引入 Bats、不访问真实 npm；本期无新增 `tests/api` / `tests/e2e` 用例（提案 §8.2），既有套件按回归执行。

## 计划期裁决（提案留白/含混处的实现口径）

1. **版本解析的严格形态**：仅接受 `^\d+\.\d+\.\d+$` 三段数字，每段 1~9 位且无前导零（`0` 本身允许）；拒绝非字符串、空串、前后空白（` 2.2.0`）、`v` 前缀、缺段/多段（`2.2`、`2.2.0.0`）、prerelease/build 后缀（`2.2.0-beta.1`、`2.2.0+build`）、超长串（> 64 字符直接拒绝，避免日志污染与无谓解析）。数字按 `Number()` 比较（段位 ≤ 9 位，天然在安全整数内）。
2. **常量与 API 归属**：`services/worker-version.ts` 为单一事实源，导出 `MIN_WORKER_VERSION = '2.2.0'`、`SUPPORTED_MAJOR = 2`、`parseWorkerVersion(raw: unknown)`（返回 `{ ok: true; major; minor; patch; raw } | { ok: false; reason: 'missing' | 'malformed'; raw }`）、`isSupportedWorkerVersion(raw, minimum?, supportedMajor?)`（返回 `{ supported: boolean; reason: string; parsed? }`）与 `sanitizeVersionForLog(raw)`。`socketio-gateway.ts` 删除 `CURRENT_MAJOR_VERSION` 导出，改引 `MIN_WORKER_VERSION` / `SUPPORTED_MAJOR`（无其他引用方，测试同步迁移）。
3. **拒绝顺序**：`register` 内先做版本门禁，再做 `hostname` 必填校验（与现状一致）；版本拒绝不进入 hostname 分支。
4. **错误载荷与文案**：复用 `error` 事件 + `VERSION_MISMATCH` 错误码；载荷追加可选 `currentVersion` / `minimumVersion` / `supportedMajor`；`message` 统一为「agent-gear 版本不兼容，当前版本 `<current>`，最低版本 `<minimum>`（supported major: `<major>`）」，`<current>` 取 `sanitizeVersionForLog` 结果（非法时 `unknown`）。旧客户端忽略新增字段。
5. **日志格式**：服务端拒绝日志形如 `[worker] register rejected containerId=<id>: VERSION_MISMATCH (agent-gear version=<current>, minimum=2.2.0, supported major=2)`，`version=` 处同样过 `sanitizeVersionForLog`；注册成功日志沿用现状（含 `version=`）。
6. **entrypoint 结构**：脚本拆为「纯函数 + `main()`」，`main` 仅在 `[[ "${BASH_SOURCE[0]}" == "$0" ]]` 时执行；`install_docker_shim` 写入路径提取为 `DOCKER_SHIM_PATH=${ZAG_DOCKER_SHIM_PATH:-/usr/local/bin/docker}`（默认行为不变，供测试指向临时目录），不新增其他测试专用开关。
7. **stderr 流式扫描**：agent-gear 的 stdout/stderr 均实时透传；stderr 经进程替换流入扫描函数，逐行原样回写 fd 2 并只把「是否出现 `VERSION_MISMATCH`」记入 `$RUN_DIR/mismatch` 标记文件，不把完整日志落盘、不产生无界磁盘增长。只认稳定错误码，不解析本地化 `message`。
8. **升级触发与循环边界**：`run_agent_gear` 返回「非零退出 + mismatch 标记 + 本轮未升级 + `ZAG_SKIP_AGENT_GEAR_UPDATE != 1`」四条件同时满足才执行升级；升级后以 `agent-gear --version` 输出非空作为可重启判据；第二次 mismatch、安装失败、`--version` 不可用均非零退出。`exit 0`、信号退出、普通非零退出（无 mismatch 标记）直接结束，不升级不重启。
9. **信号转发**：trap 处理函数置 `shutting_down=1`，向当前 agent-gear / npm 子进程 `kill -TERM`（必要时 `kill -INT`）并 `wait`，随后以 0 退出；主循环每轮检查 `shutting_down`，置位后不得再拉起 agent-gear 或执行升级。
10. **测试基线回填**：`socketio-gateway.test.ts` 存量用例使用 `version: '2.0.0'` / `'2.1.0'`（T-G2/T-G4/T-G5/T-G7/T-G9/T-G10/T-G11 等），新门禁下会被拒绝，须统一改用兼容版本并提取测试常量 `OK_VERSION = '2.2.0'`（`common-rules.md`「状态机语义演进要回填测试断言」）。
11. **销毁语义只锚定不改造**：`destroyLocked` 已按 `destroying.connectedAt !== null` 决定 `notifyShutdown` + `shutdownGraceMs`，本期仅补一条「`connectedAt = null` 直接删 Job」的测试锚定；不新增配置、不改状态机。
12. **入口测试运行方式**：`entrypoint.test.sh` 以子进程方式运行 `bash entrypoint.sh`（不 source，避免 `set -euo pipefail` 影响测试 harness），通过临时 PATH stub `dockerd`/`docker`/`npm`/`agent-gear` 与 `ZAG_DOCKER_SHIM_PATH` 覆盖实现确定性，不启动真实 dockerd、不访问网络。
13. **开发分支口径**：改动集中在 `servers/cloud-controller` 与 `deploy/images/worker`，无 apps/packages/tests 变更，采用单一开发分支 `feat/controller-version-requirement-impl`，不按子项目拆并行分支；契约变更独立提交先行合入。

---

## Phase 1: 契约变更（contracts/）

### 文件修改

| 文件 | 动作 | 内容 |
|------|------|------|
| `contracts/cloud-controller-websocket.md` | 修改 | §2.2 `register`：`version` 说明改为「semver 三段数字，须 `>=2.2.0` 且 major 为 `2`，见 §3.4」；服务端行为第 2 条改为完整版本门禁（缺失/非法/低于最低版本/错误 major 一律 `VERSION_MISMATCH` 并断开）。§2.4 `error` 载荷表追加 `currentVersion`/`minimumVersion`/`supportedMajor`（均可选）并附示例 JSON；`VERSION_MISMATCH` 含义改为「版本不在兼容范围（低于最低版本或 major 不符）」。§3 时序图「校验 version major」改为「校验 version（>=2.2.0 且 major=2）」。§3.4 版本兼容改为完整规则（解析顺序、拒绝副作用：不写 `registered`/`connectedAt`/online、不下发 workload、销毁不等待）。 |

### 验收 checklist

- [ ] 契约独立提交（`docs(contracts): 约定 worker 最低版本门禁与 VERSION_MISMATCH 载荷`），先于任何实现提交
- [ ] 与提案 §3.1 的载荷表、副作用约束逐项一致；错误码表不含新增错误码
- [ ] 旧客户端兼容性描述保留（旧客户端忽略新增字段、按既有路径打印并退出）

---

## Phase 2: cloud-controller 版本门禁（TDD）

### 文件修改

| 文件 | 动作 | 内容 |
|------|------|------|
| `servers/cloud-controller/src/services/worker-version.ts` | 新增 | `MIN_WORKER_VERSION` / `SUPPORTED_MAJOR` / `parseWorkerVersion` / `isSupportedWorkerVersion` / `sanitizeVersionForLog`（裁决 1/2/5）；纯函数、零依赖、无 IO |
| `servers/cloud-controller/src/services/worker-version.test.ts` | 新增 | 版本矩阵与边界（T-V*） |
| `servers/cloud-controller/src/services/socketio-gateway.ts` | 修改 | `register` 内 major 判断替换为 `isSupportedWorkerVersion`；错误载荷追加 `currentVersion`/`minimumVersion`/`supportedMajor`；拒绝日志含当前/最低版本并过 `sanitizeVersionForLog`；删除 `CURRENT_MAJOR_VERSION` 导出，引用 `worker-version.ts` 常量 |
| `servers/cloud-controller/src/services/socketio-gateway.test.ts` | 修改 | 存量用例版本基线回填 `OK_VERSION = '2.2.0'`（裁决 10）；新增 T-GV* 用例 |

### 测试用例（增量）

`worker-version.test.ts`：

- **T-V1**：`2.2.0`、`2.2.1`、`2.10.0` 支持（数字比较，`2.10.0` 不被字典序误判为低于 `2.2.0`）
- **T-V2**：`2.1.9`、`2.1.0`、`0.9.9` 拒绝（低于最低版本）；自定义 `minimum` 参数生效
- **T-V3**：`3.0.0`、`1.2.3` 拒绝（major 范围）；自定义 `supportedMajor` 参数生效
- **T-V4**：`undefined`、`null`、`''`、`' 2.2.0'`、`'2.2.0 '`、`'v2.2.0'`、`'2.2'`、`'2.2.0.0'`、`'2.2.0-beta.1'`、`'2.2.0+build'`、`'02.2.0'`、`'2.02.0'`、`'a.b.c'`、非字符串对象、> 64 字符串全部拒绝，`reason` 可区分 `missing` / `malformed`
- **T-V5**：`sanitizeVersionForLog` 去除控制字符、截断到 64、非法/缺失回退 `unknown`

`socketio-gateway.test.ts`（真实 socket.io-client，沿用现有 harness）：

- **T-GV1**：`register { version: '2.1.0' }` → 收到 `error`：`code=VERSION_MISMATCH`、`currentVersion='2.1.0'`、`minimumVersion='2.2.0'`、`supportedMajor=2`、`message` 含当前与最低版本，随后断开
- **T-GV2**：拒绝零副作用——spy `markOnline`、`markInitializing`、`hasInitScripts`、`startInit`、`heartbeatTracker.record` 均未调用；`socket.data.registered` 未置位；容器记录 `connectedAt` 保持 `null`、状态不进入 `online`/`initializing`
- **T-GV3**：`'2.2.0'`、`'2.10.0'` 注册成功（回归，`registered` + online/initializing 流程不变）
- **T-GV4**：缺失 `version`、`'x.y.z'`、`'3.0.0'` 均拒绝；`currentVersion` 为原始值或 `unknown`
- **T-GV5**：拒绝后 socket 断开不再改容器状态（`disconnect` 分支不 `markConnecting`）
- **基线回填**：T-G2/T-G4/T-G5/T-G7/T-G9/T-G10/T-G11 等存量用例版本改 `OK_VERSION`

### 命令参考

```bash
cd servers/cloud-controller
npx vitest run src/services/worker-version.test.ts
npx vitest run src/services/socketio-gateway.test.ts
npm run build
```

### 验收 checklist

- [ ] T-V* / T-GV* 全部通过；先 RED 后 GREEN，重构后全绿
- [ ] 拒绝路径无任何注册副作用（T-GV2 的 5 个 spy 全部零调用）
- [ ] `npm run build`（TypeScript strict）通过；新增代码覆盖率 ≥ 80%
- [ ] 存量网关用例全部回归通过（基线回填后行为语义不变）

---

## Phase 3: 销毁副作用锚定（TDD）

### 文件修改

| 文件 | 动作 | 内容 |
|------|------|------|
| `servers/cloud-controller/src/services/container-service.test.ts` | 修改 | 新增未兼容注册容器销毁用例（T-S19）；不改 `container-service.ts`（若用例失败，说明既有语义被破坏，按提案 §4.1 修复后回归） |

### 测试用例（增量）

- **T-S19**：`connectedAt === null` 的容器（从未完成兼容注册，如版本被拒）调用 `destroy` → `onShutdown` 回调不触发（不发 shutdown、不跑 post 批次）、`shutdownGraceMs > 0` 也不产生宽限等待（计时断言或 spy delay），仍删除 Job 并收口 `exited`、清空 `tokenHash`
- **T-S20**（回归锚定）：`destroying` 快照后并发 `markOnline` 写入 `connectedAt` 的既有用例（T-S18）保持通过——两种口径互不回归

### 命令参考

```bash
cd servers/cloud-controller
npx vitest run src/services/container-service.test.ts
```

### 验收 checklist

- [ ] T-S19/T-S20 通过；destroy 语义无行为变更
- [ ] 版本拒绝容器的强制销毁路径不引入 post 预算或 shutdown 宽限等待

---

## Phase 4: worker entrypoint 监督恢复（TDD）

### 文件修改

| 文件 | 动作 | 内容 |
|------|------|------|
| `deploy/images/worker/entrypoint.sh` | 修改 | 拆分 `install_docker_shim` / `start_dockerd` / `update_agent_gear` / `run_agent_gear`（stderr 流式扫描）/ `maybe_upgrade_agent_gear` / `supervise_agent_gear`（循环）/ `shutdown`（信号转发）/ `main`（裁决 6~9）；保留启动更新、dockerd、shim 行为与 `ZAG_SKIP_AGENT_GEAR_UPDATE` 语义 |
| `deploy/images/worker/entrypoint.test.sh` | 新增 | 纯 Bash + 临时 PATH stub 的恢复/失败/信号测试（T-EP*），无 Bats、无网络 |
| `deploy/images/worker/BUILD.md` | 修改 | 「默认启动」段更新为「启动更新 → 受监督运行 → 版本不匹配一次自升级重连」；新增「版本门禁与自升级自验」小节（含 `bash -n` 与 `entrypoint.test.sh` 步骤、K8s 受控旧版验收清单）；同步「工作负载执行自验」中版本校验口径为 `>=2.2.0` 且 major 2 |

### 测试用例（增量，`entrypoint.test.sh`）

stub 约定：临时目录内假 `agent-gear` 按用例打印 `VERSION_MISMATCH` 并记录启动次数；假 `npm` 按用例切换版本或失败并记录安装次数；假 `dockerd`/`docker` 直接成功；`ZAG_DOCKER_SHIM_PATH` 指向临时文件。

- **T-EP1**（自升级重连）：首轮 `2.1.0` 打印 `VERSION_MISMATCH` 退出 1 → 安装 1 次 → 重启后 `2.2.0` 正常运行（启动 2 次、安装 1 次）
- **T-EP2**（安装失败）：npm 非零 → 进程非零退出，安装 1 次，无重启循环
- **T-EP3**（二次拒绝）：升级后仍 `VERSION_MISMATCH` → 不再安装，非零退出
- **T-EP4**（跳过开关）：`ZAG_SKIP_AGENT_GEAR_UPDATE=1` → 不安装、直接非零退出
- **T-EP5**（普通错误）：非零退出但无 `VERSION_MISMATCH` → 不安装、不重启
- **T-EP6**（正常退出）：exit 0 → 不安装、不重启
- **T-EP7**（信号）：运行中 `kill -TERM` → 子进程收到 SIGTERM、退出 0、不重启、不安装；`kill -INT` 同理
- **T-EP8**（日志有界）：mismatch 只经 stderr 流式扫描记录标记，运行目录无完整日志落盘；stdout/stderr 均实时透传
- **静态检查**：`bash -n deploy/images/worker/entrypoint.sh`

### 命令参考

```bash
bash -n deploy/images/worker/entrypoint.sh
bash deploy/images/worker/entrypoint.test.sh
```

### 验收 checklist

- [ ] T-EP1~T-EP8 全部通过；`bash -n` 通过
- [ ] 单次容器运行最多一次升级；所有失败路径收敛为非零退出（无循环）
- [ ] SIGTERM/SIGINT 转发给 agent-gear 并等待退出，销毁信号后不重启
- [ ] dockerd 与 docker shim 行为、启动更新语义、`ZAG_SKIP_AGENT_GEAR_UPDATE` 语义均不变

---

## Phase 5: 文档收口 + 全量回归 + PR

### 文件修改

| 文件 | 动作 | 内容 |
|------|------|------|
| `servers/cloud-controller/AGENTS.md` | 修改 | 「关键约束」补：worker 注册须 `>=2.2.0` 且 major 2（`MIN_WORKER_VERSION`/`SUPPORTED_MAJOR` 常量）；版本拒绝零副作用、不写 `connectedAt`；`VERSION_MISMATCH` 载荷扩展；架构图补 `worker-version.ts` |
| `docs/engineering/AGENTS.md` | 修改 | 「实现计划（`plan/`）」索引补本计划链接 |
| `docs/engineering/plan/20261017-feat-controller-version-requirement.md` | 修改 | 开发过程中按实际情况更新进度与裁决 |

### 命令参考

```bash
# 后端
cd servers/cloud-controller && npm run build && npx vitest run --coverage
cd servers/admin-api && npm run build && npx vitest run
# agent-gear（本期零改动，回归即可）
cd packages/agent-controller && npm run build && npx vitest run
# 入口脚本
bash -n deploy/images/worker/entrypoint.sh && bash deploy/images/worker/entrypoint.test.sh
# 部署侧手工验收（内网镜像 + K8s，见 BUILD.md 新增小节）
```

### 总体验收 checklist

- [ ] cloud-controller 单测与 strict build、entrypoint 测试与 `bash -n` 全部通过；新增代码覆盖率 ≥ 80%
- [ ] PRD §1.3/§3.2 逐条核对：
  - [ ] `2.1.0` 被拒绝并给出最低版本提示，不进入可用状态（功能点 1）
  - [ ] `2.2.0`/`2.10.0` 直接通过、数字版本比较、缺失/非法拒绝、不收初始化/清理任务（功能点 1）
  - [ ] `2.1.0` 被拒后自动升级并重连，恢复后可调度初始化脚本与响应强制销毁；兼容版不触发；网络断线不误判（功能点 2）
  - [ ] 单次运行最多一次升级、失败记录原因、二次不兼容明确退出、未兼容注册不延长强制销毁等待、升级中收到销毁信号即退出（功能点 3）
  - [ ] 日志含当前/最低版本、升级与重连结果、失败原因，且无密钥/令牌（功能点 4）
- [ ] PRD §3.5 边界逐条核对（等于最低版本、版本缺失、升级源不可用、升级后仍不兼容、网络波动、升级期间销毁信号、存量旧容器强制销毁重建）
- [ ] 提案 §10 验收标准逐条核对（契约评审、注册副作用前拒绝、版本矩阵、零副作用、一次自升级、npm 失败/二次拒绝/skip 不循环、信号语义、销毁不等待、测试全绿、内网 K8s 受控验收、日志脱敏）
- [ ] 既有回归：网关/容器/工作负载/心跳相关套件无退化（含基线回填后的 T-G*）
- [ ] 内网 K8s 手工验收：新镜像正常回连；受控 `2.1.0` 旧版容器在新入口下自升级重连并完成 init/post；强制销毁即时完成；日志核对无凭据
- [ ] 开发分支 PR 合并回 `feat/controller-version-requirement`，需求总 PR #218 自动更新；实现计划文档保留在需求总分支

## 风险与回滚

| 风险 | 缓解 |
|------|------|
| 仅改新 CLI 无法覆盖存量 `2.1.0` | 自升级落在 entrypoint（裁决 6~8）；旧入口容器一次性销毁重建（提案 §9.1 发布顺序） |
| npm registry 无兼容版本导致升级循环 | 单次升级 + 二次拒绝即退出（T-EP2/T-EP3）；日志明确失败原因 |
| 版本字符串伪造污染日志 | `sanitizeVersionForLog` 去控制字符、截断 64、长度上限前置拒绝（T-V4/T-V5） |
| stderr 扫描造成磁盘增长或日志丢失 | 流式扫描只留标记、不落盘，实时透传（T-EP8） |
| 信号转发遗漏导致销毁后容器卡住 | trap 转发 + `shutting_down` 标记禁止重启（T-EP7）；销毁路径不依赖 shutdown 等待（T-S19） |
| 门禁顺序被后续改动破坏（先副作用后校验） | T-GV2 五个 spy 零调用 + 契约 §3.4 副作用约束写入 `servers/cloud-controller/AGENTS.md` |
| 存量测试版本基线腐化导致假失败 | 统一 `OK_VERSION` 常量回填（裁决 10）；全量回归核对 |
| 部署窗口内新门禁 + 旧入口镜像共存 | 发布顺序：先推新入口镜像并重建存量容器，再启用门禁（提案 §9.1）；`ZAG_SKIP_AGENT_GEAR_UPDATE=1` 保留排障出口 |

## 相关文档

- 关联 PRD：`docs/product/draft/20261017-controller-version-requirement.md`
- 关联 Proposal：`docs/engineering/proposals/20261017-feat-controller-version-requirement.md`
- 既有 PRD/提案：`docs/product/draft/20261017-cloud-controller-workload.md`、`docs/engineering/proposals/20261017-feat-cloud-controller-workload.md`
- 既有实现计划：`docs/engineering/plan/20261017-feat-cloud-controller-workload.md`、`docs/engineering/plan/20261014-feat-cloud-agent-phase2.md`
- 契约：`contracts/cloud-controller-websocket.md`
- 开发规范：`docs/engineering/common-rules.md`、`docs/engineering/backend-rules.md`
- 子项目规范：`servers/cloud-controller/AGENTS.md`、`deploy/images/worker/BUILD.md`
