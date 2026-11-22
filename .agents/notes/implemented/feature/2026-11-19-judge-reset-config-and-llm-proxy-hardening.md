# Agent Note: 新增 judge reset-config 命令并加固 Judge 到 LLM 网关连接

Status: implemented

## Problem

在 2026-10-16 LMCC 模拟赛复盘（`dev-docs/postmortem/2026-10-16-lmcc-mock-contest-hotfix.md`）及后续全链路排查中暴露出两类高影响运维与稳定性缺陷：

1. **资源组容量调整缺乏 CLI 维护入口**：`Scheduler::connect` 首次启动会把各资源池并发与内存预算以 `SETNX` 锁进 Redis `{prefix}:resources:{group}:config`；调整并发时必须先等所有同组 Worker 心跳（30s）与租约（60s）过期再清除配置锁，且原有 `Scheduler::reset_group_config` 漏删了 `:turn-sequence` 键。此前只能停机后人工临时跑 Rust 脚本清键，并手工改 `.env.judge` 与重渲染 Compose；同时 `judge install --redis-mode local` 将 `runtimeUrl`（`host.docker.internal`）与 `checkUrl`（`127.0.0.1`）反置写入了 `REDIS_CHECK_URL` 与 `REDIS_URL`。
2. **Judge → LLM Gateway → 上游链路存在多处断连与静默失败隐患**：
   - 独立 Judge 转发器 `deploy/judge-llm-proxy.py` 在 `watch_client()` 中把瞬时 `BlockingIOError` / `InterruptedError` 误判为客户端断开并主动 `shutdown` 上游连接，且在客户端管道有未读字节时忙轮询；同时缺少 TCP Keepalive、高并发监听队列偏小（默认 5）、请求体上限（1 MiB）低于网关（10 MiB）、也未透传 `X-Noj-Call-Id`。
   - Evaluator SDK `noj_evaluator_sdk.llm` 未捕获 `http.client.HTTPException`（`RemoteDisconnected` / `IncompleteRead`），直接跳过内置有界重试，也未启用 TCP Keepalive 与 `Connection: close`。
   - `noj-llm-gateway` 的 `nodePinnedTransport` 对字符串请求体使用 `body.length`（UTF-16 长度）而非 UTF-8 字节长度计算 `Content-Length`，含中文 prompt 时会发错字节长度导致上游截断或断连；同时上游 socket 未开启 Keepalive，响应读流失败也没有日志记录。

## Decision

1. **补全 `Scheduler::reset_group_config`、关闭旧容量 Worker 竞态窗口，并提供 `noj-cli judge reset-config`**：
   - 在 `noj-judge/src/scheduling.rs` 将 `:turn-sequence` 纳入 `reset_group_config` 的原子清理列表（共 7 个键，保留 `:sequence` 兼容旧键）；同时在 `ACQUIRE` Lua 脚本头部校验 `KEYS[6]`（`:config`）必须等于当前 Worker 容量 JSON（不匹配返回 `-3` / `GroupConfigMismatchError`），并在 `main.rs` 遇到该错误时停止准入（如已拉取任务则原子放回队列）、排空后带错退出；在 `metrics.rs` 写入 `:rss` 心跳前亦先核验 `:config` 并原子检查写回，杜绝启动尚无心跳/租约的旧容量 Worker 在清锁后仍继续接单或覆盖心跳。
   - 在 `noj-cli/src/prod/judge/redis-resp.ts` 实现纯 Deno 严格 RESP2 TCP/TLS 客户端，在同一连接上顺序执行 `AUTH`（如有）→ `SELECT <db>` → `EVAL`，任一步未收到 `+OK` 立即中止；替代此前基于 `redis-cli`（DB 超界报 stderr 后仍误退回 DB 0 执行且吞掉认证/选库错误）的实现。
   - 在 `noj-cli/src/prod/judge/reset-config.ts` 与 `reset-config-helpers.ts` 实现 `judgeResetConfig` 并接入命令表、参数校验白名单、帮助文本与 `runProdJudge`：
     - 在停机前严格校验选项（拒绝 `--dry-run=true` 等布尔 `=` 写法、未知选项以及包含换行/控制字符的 `--pools` 并将其规范化为单行）、共享 Docker socket 守卫与调度参数；
     - 运行期调用 `docker compose config`（`--dry-run` 时按 `hostEnv > .env.judge` 规则静态展开，若含 `env_file` 则拒绝 `--dry-run`）提取 `services.judge.environment` 的权威生效值以确定 `resourceGroup`、`claimPrefix`、`REDIS_URL` 与停机宽限期；
     - 在停机前校验 `REDIS_URL` / `REDIS_CHECK_URL` 格式（失败仅报错类别与字段名，绝不回显原始 URL，彻底杜绝含 `/` 口令泄漏）与同实例同库一致性，向后兼容历史 `judge install --redis-mode local` 的反置地址，并同步修复 `judge install --redis-mode local` 的写入顺序；
     - 为 `judgeStop` 同步补充根据生效配置计算的 `compose stop -t <sec>`（默认 ≥120s），使多节点文档第一步同样保留完整优雅排空窗口；
     - 停机与清锁前预先通过独占临时文件暂存并 `syncData` 验证 `.env.judge` 与 `docker-compose.judge.yml` 可写性，清锁成功后先原子提交 `.env.judge` 再提交 Compose，第二阶段失败时自动将 `.env.judge` 原子回滚至原始内容与权限。
2. **全链路加固 Judge → LLM Gateway 连接稳定性与可观测性**：
   - `deploy/judge-llm-proxy.py`：引入 `ProxyHTTPServer`（`request_queue_size=128`、`daemon_threads=True`）及跨平台 `enable_tcp_keepalive`；修复 `_peek_client_closed` 仅在真实 EOF/连接错误时触发断连；请求体上限对齐 10 MiB；透传 `X-Noj-Call-Id` 并输出脱敏的上游异常日志。
   - `noj-judge/sdk/evaluator/noj_evaluator_sdk/llm.py`：保留测试对 `urllib.request.urlopen` 的替换及调用方通过 `urllib.request.install_opener` 安装的网络配置（CA/代理/重定向策略），仅在调用方未配置全局 `_opener` 时使用模块私有 `_KEEPALIVE_OPENER` 发起请求；请求显式发送 `Connection: close`，将 `http.client.HTTPException` 纳入有界重试并统一转为 `LLMError("LLM gateway 连接失败: ...")`。
   - `noj-llm-gateway/src/upstream-guard.ts` 与 `src/routes/llm.ts`：`nodePinnedTransport` 统一将字符串编码为 UTF-8 `Uint8Array` 后以 `byteLength` 设置 `content-length` 并写入；上游请求 socket 启用 `setKeepAlive(true, 30_000)`；补充非敏感的 `error_name` / `transport_error_code` 日志与响应读取失败告警日志。

## Alternatives considered

- **在 `noj-judge` 启动参数中增加 `--force-reset-group` 自动清锁**：被否定。启动时自动清锁无法确认同组其他节点是否已排空，并发重启可能造成容量脑裂。由显式运维命令 `noj-cli judge reset-config` 执行「先检过期、后删锁、再局部更新配置」更安全。
- **重置后直接调用 `renderJudgeCompose` 整份覆写 `docker-compose.judge.yml`**：被否定。整份覆写会丢掉运维按模板注释配置的 `networks.*.external: true` 等部署定制，且未改参数时不应重写 Compose；改用 YAML AST 局部只更新变更键可完整保留定制。
- **在 `noj_evaluator_sdk.llm` 安装进程全局 `urllib` opener**：被否定。会覆盖评测脚本自身的代理或 TLS opener，改用模块私有 `_KEEPALIVE_OPENER` 更安全。

## Consequences

- 运维人员可通过 `noj-cli judge reset-config` 安全排空并调整单机或多节点同组 Worker 的并发/内存预算，而不丢失既有 Compose 网络/挂载定制或泄露 Redis 口令。
- 中文 Prompt 经过 `noj-llm-gateway` 的固定地址传输层时 `Content-Length` 恢复准确；Evaluator SDK 与独立转发器在瞬时断开、长推理空闲和异常上游断流下具备 Keepalive、明确 502 与可控重试行为，且不污染调用方的全局 `urllib` 配置。
