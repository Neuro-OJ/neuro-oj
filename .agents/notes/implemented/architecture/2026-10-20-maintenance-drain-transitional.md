# Agent Note: 升级排空的过渡能力（P1d）

Status: implemented

## Problem

升级会替换正在运行的 core/judge 镜像。此前没有协调点能保证：

1. **新写入已停止**：虽然 Core 早有 `maintenance_mode` 设置与维护中间件，但没有面向运维/CLI
   的可靠入口；一旦开启维护模式，内部端点也会被中间件顺手拦掉，无法在维护中查询状态或退出。
2. **在途工作已清空**：判分任务可能在队列、`processing` 列表、`evaluation_attempts` 或
   Judge Worker 内执行，升级瞬间直接替换进程会让这些事实分散在旧版本里。
3. **节点版本不可见**：多节点 Judge 的升级由各节点自行进行，服务端无法从既有心跳判断
   “该节点是否已运行目标版本”。

P1 的目标是在协议切换前先具备排空与版本报告能力，使后续维护窗口可以“先排空、再切换”。

## Decision

按“接口收口在 Core、协议收口在容器内 CLI、命令收口在 noj-cli”的分层实现：

1. **Core 内部维护 API**（[internal-drain.ts](../../../../noj-core/src/modules/platform/system/routes/internal-drain.ts)）：
   `GET /api/v1/internal/drain/status`、`POST .../enter`、`POST .../exit`。凭据为独立的
   bootstrap 配置 `NOJ_INTERNAL_SERVICE_TOKEN`（settings registry 登记、常量时间比较）；
   未配置返回 503 `drain_unavailable`，错误返回 401；enter/exit 幂等（`changed` 标志），
   复用 `updateSetting("maintenance_mode", …, ROOT_USER_ID)` 以保证缓存重载与跨副本通知。
   排空状态不缓存（`Cache-Control: no-store`）。
2. **维护中间件工厂化**（[maintenance.ts](../../../../noj-core/src/shared/http/maintenance.ts)）：
   从 `app.ts` 抽出 `createMaintenanceMode(reader)`，shared 层不依赖业务域；维护模式下放行
   `/api/v1/internal/*`（内部端点自带凭据），其余写请求仍返回 503 `MAINTENANCE`。
3. **排空判定**（[drain-status.ts](../../../../noj-core/src/modules/platform/system/services/drain-status.ts)）：
   `computeDrainState` 纯函数 + 可注入 `readDrainStatus`。blockers 固定为 9 类：
   `maintenance_off`、`redis_unavailable`、评测/结果队列的 pending/processing、
   `attempts_in_flight`（`evaluation_attempts.state ∈ queued/judging`）、
   `judge_workers_missing`、`judge_tasks_active`；dead 队列只报告不阻塞；
   `drained = blockers 为空`。system 域不跨域 import：队列健康与 Judge 心跳由
   [app.ts](../../../../noj-core/src/app.ts) 组合根注入。
4. **Judge 版本上报**（[metrics.rs](../../../../noj-judge/src/metrics.rs)）：心跳 JSON 增加
   `judge_version = env!("CARGO_PKG_VERSION")`；Core 读端新增 `readJudgeNodeReports`
   （保留原聚合 `readJudgeHeartbeats` 行为不变），status 逐节点返回实例、版本、资源组、
   活跃任务与心跳时间。
5. **容器内维护 CLI**（[maintain.ts](../../../../noj-core/scripts/maintain.ts) +
   [noj.ts](../../../../noj-core/scripts/noj.ts)）：`/app/bin/noj maintain enter|status|wait|exit`，
   通过 HTTP 调 Core；`--json` 时 stdout 只输出一个文档；失败码稳定
   （`endpoint_unavailable` / `unauthorized` / `drain_unavailable` /
   `timeout` / `not_drained` / `network_error` / `http_error`），
   wait 轮询默认 5s、超时默认 1800s。
6. **noj-cli 接入**（[maintain.ts](../../../../noj-cli/src/prod/maintain.ts)、
   [drain.ts](../../../../noj-cli/src/prod/lifecycle/drain.ts)、
   [lifecycle.ts](../../../../noj-cli/src/prod/lifecycle.ts)）：
   `noj-cli maintain …` 以 `docker compose run --rm --no-deps --entrypoint /app/bin/noj core`
   执行（Tier 3 容器命令）；`update` 在 pull + 验签成功之后、启动目标栈之前执行
   `enter → wait`，`waitForStack` 成功后执行 `exit`。失败语义：enter/wait 失败不启动
   目标栈、不提交暂存配置并尽力 exit；`exit` 失败（服务已升级但仍在维护模式）显式返回失败并提示人工
   `noj-cli maintain exit`，暂存配置照常提交。`--skip-drain` 关闭自动排空，
   `--drain-timeout` 调整等待上限。唯一自动放行的过渡例外是
   `endpoint_unavailable`（旧 Core 无端点）：告警后继续一次性升级。
7. **配置与门禁**：`NOJ_INTERNAL_SERVICE_TOKEN` 加入 docker-compose 注入与
   `.env.prod.example`（可选，未设置则自动排空不可用）；内部凭据端点登记
   `check-write-rate-limits` 的 exempt 理由；`route-catalog.md` 由生成器重新生成（+3 路由）。

## Alternatives considered

- **复用 `NOJ_LLM_SERVICE_TOKEN` 作为维护凭据**：实现最省事，但会让持有 LLM 服务凭据的组件
  获得切换维护模式的权限，违反最小权限；改为独立可选的 bootstrap 凭据，未配置时端点关闭。
- **CLI 直接从宿主机通过 nginx 调 Core**：生产 compose 只暴露 nginx，内部路径不对外；新增
  nginx 反向代理会把内部管理面暴露到公网边缘，风险高于收益。容器内 CLI 走 compose 网络更贴合
  信任边界。
- **容器内 CLI 直接读写 DB/Redis 并发布设置失效事件**：会复制一份服务端配置/审计逻辑，且
  依赖 Pub/Sub 可达性；HTTP 调 Core 让权限、缓存重载与审计只保留一处实现。
- **只在 install/手工文档里让人工开启维护模式**：没有“排空完成”的判定与超时终止，无法在
  升级流程中复用；也看不到 Judge 节点版本。
- **把 full maintenance window（暂停任务领取、迁移、备份/恢复顺序）也塞进 P1d**：范围过大且
  依赖发布集、迁移入口与备份恢复编排，按方案归 P8；P1d 只做过渡能力与升级前后的安全闸门。

## Consequences

- 自动排空依赖新配置 `NOJ_INTERNAL_SERVICE_TOKEN`：升级到本版本的**首次**切换时旧 Core 尚未
  提供 drain 端点，需在 `.env.prod` 配置凭据并用 `--skip-drain`（或手工维护模式）完成一次
  过渡；此后 `update` 默认自动排空。未配置凭据时 update 会中止并给出可操作提示。
- 维护模式期间写请求返回 503 `MAINTENANCE`（读请求与内部端点不受影响）；排空等待上限
  默认 1800s，由 `--drain-timeout` 调整，超时不会强杀任务。
- `/health`、`/health/live` 与现有 `maintenance_mode` 管理入口语义不变；Judge
  心跳只新增字段，旧 Core 读取端对缺字段容错。
- 验证证据：Core `test-domain system`（隔离 Redis）174 passed、`test-shared`
  317 passed；noj-cli 809 passed；Judge metrics 3 passed 且 clippy 通过；根
  `check-ci` 217 passed（含 config-usage 144 键、域边界、路由目录、限流登记）。
- 未做真实 Docker/Core 联调与 PostgreSQL 上的长排空演练；wait 成功到 up 之间仍可能被新的
  批量任务派发插空（需 P8 的“暂停领取 + 静默窗口”收口），完整维护窗口顺序仍归 P8；
  `readJudgeNodeReports` 尚未有独立 fake-redis 单测（由路由/状态测试间接覆盖）。
