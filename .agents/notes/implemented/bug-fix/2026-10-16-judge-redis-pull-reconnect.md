# Agent Note: Judge 拉取与 claim 失败后重建 Redis 连接

Status: implemented

## Problem

2026-10-16 独立判题节点 judge1 卡评测：局域网路由器 DNS 缓存了 `neuro-oj.icu`
已废弃的旧 IP，`noj-judge-tunnel` 客户端断线后持续重连旧地址，Worker
经隧道访问的 Redis 不可达，任务滞留在 `noj:judge:queue:ai:medium`。

修复 DNS、隧道 4 秒内重连后，Worker 仍持续报 `RPOPLPUSH 拉取任务失败`。原因是
主循环在启动时创建一个 `MultiplexedConnection` 并永久复用；redis-rs
的该连接在底层 TCP 断开后不会自动重连，上游恢复后依然每次失败，只能靠节点上的
`noj-judge-queue-recovery` 定时器检测日志后重启容器（约 30–40 秒）。

## Decision

- 拉取任务返回错误时，先释放已获取的并发槽位，等待 `PULL_RETRY_DELAY` 后用
  `redis_client` 重建主循环的拉取连接，成功即替换旧连接。
- 用户级 claim 专用连接同理：`try_claim_user` 失败时重建
  `claim_conn`。否则拉取恢复后 claim 仍走失效连接，任务被判"占用失败"后每 100ms
  放回队尾，形成不报拉取错误的空转， 节点恢复定时器也无法发现。
- 重建限时 5 秒（`REDIS_RECONNECT_TIMEOUT`），避免上游黑洞时 TCP
  握手长时间挂起、 主循环无法响应关闭信号；失败只记 warn，下一轮继续重试。
- judge1 运维侧：`/etc/resolv.conf.head` 优先使用公共 DNS（223.5.5.5、
  119.29.29.29），路由器 DNS 作为兜底；dhcpcd 续租会保留该文件。

## Alternatives considered

- 改用 `redis::aio::ConnectionManager`：可自动重连，但需要改动 `mq.rs` 中以
  `MultiplexedConnection` 为参数的函数签名及测试，改动面超出本次热修复。
- 仅依赖节点 `noj-judge-queue-recovery` 定时器重启
  Worker：恢复慢且依赖部署侧脚本， 其他节点不一定配置。
- 在 `/etc/hosts` 固定入口 IP：入口再次迁移时会以同样方式失效。

## Consequences

- 上游 Redis 恢复后，Worker 在下一轮拉取（约 1 秒）内自行恢复，无需重启容器；
  两处重建共用 `reconnect_redis()`。
- Redis 持续不可达期间每轮最多多一次限时 5 秒的重连尝试，日志多一条 warn。
- 结果推送、心跳、重投等路径本就按次新建连接，不受影响。
- 断线前已在跑的任务，其 `ActiveUserGuard` 持有旧 claim
  连接，结束时释放可能失败， 该用户 claim 依赖既有 TTL（默认 1
  小时）过期；本次未改动该行为。
