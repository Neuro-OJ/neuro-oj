# Agent Note: 评测任务三级优先级队列

Status: implemented

## Problem

评测任务原本只有一个 Redis 列表 `noj:judge:queue`，所有提交按到达顺序消费。竞赛进行中时，大量普通提交与自测会和竞赛提交混在同一个队列里排队，竞赛提交无法优先评测；管理员批量重测又会一次性灌入大量任务，进一步加剧积压。

同时旧实现存在几个可靠性问题：

- judge 每轮对 7 个轮转槽位各做一次阻塞 `BRPOPLPUSH`，队列全空时一轮空转最长 7×timeout（默认 700ms），低优先级任务最坏要等 6 次高优先级空轮询才被取到；
- 游标推进 `(cursor+offset+1)%7` 使得宣称的 4:2:1 只在 high 队列持续非空时成立；
- 活跃用户重投（公平调度）与 sweeper 超时重投都是「先 RPUSH 再 LREM」两步非原子操作，断连/崩溃会让任务重复投递或丢失；
- 队列前缀只在 judge 侧可配置，core 侧硬编码字面量，运维一旦修改前缀会导致全部评测静默停摆；
- 管理端可观测性（Prometheus 指标 / 告警阈值 / 队列页）仍读取旧单队列，三级拆分后恒为 0；
- 升级瞬间残留在旧队列与旧 processing 列表中的任务既不会被新 judge 消费，也不会被 sweeper 扫描，会永久卡在 pending/judging。

## Decision

把评测任务队列拆成三级优先级队列，core 负责服务端推导优先级，judge 负责按固定比例轮转消费。

- **队列命名**：`{JUDGE_QUEUE}:high|:medium|:low`（默认 `noj:judge:queue:high|:medium|:low`）。前缀的唯一事实源放在 `noj-core/src/shared/mq/judge-queues.ts`，core 与 judge 共用 `JUDGE_QUEUE` 环境变量；`docker-compose.prod.yml`、`scripts/deploy/judge-install.sh`、`.env.prod.example` 同步下发。
- **优先级推导**（`resolveJudgeTaskPriority`）：`rejudge` 恒为 low、`self_test` 恒为 medium、普通提交为 medium、进行中竞赛提交为 high；`priority` 是 `JudgeTask` 必填字段且只由服务端写入，客户端无法伪造。
- **入队**：每级队列独立容量上限（high 5000 / medium 10000 / low 20000），仍用单条 Lua 脚本原子完成「容量检查 + LPUSH」，满队列拒绝而不是丢弃。
- **消费**：judge 先用**非阻塞** `RPOPLPUSH` 按 `PRIORITY_SEQUENCE = [0,0,0,0,1,1,2]` 依次探测三个队列，命中即返回；三个队列都空时才做**一次**阻塞 `BRPOPLPUSH`。这样有任务时零阻塞、比例严格 4:2:1、low 不会排在高优先级空队列的多次超时之后。
- **并发**：先获取全局 `Semaphore` 槽位再拉取任务（`main.rs`），任务不会在 `processing` 里空等槽位被 sweeper 误判超时重投；槽位持有到评测结束（RAII）。
- **原子性**：活跃用户重投（`mq.rs`）与 sweeper 超时重投（`sweeper.ts`）都改为单条 Lua 脚本，`LREM` 与 `RPUSH` 原子完成，仅当消息确实还在 processing 时才重投。
- **可观测性**：`observability.ts` 跨三级队列聚合 pending/processing，Prometheus 指标与 backlog 告警重新生效。
- **迁移**：启动时执行一次性迁移（`legacy-judge-queue.ts`），把旧 `noj:judge:queue` 与 `:processing` 中的消息补上 `priority: "medium"` 后逐条原子搬入 medium 队列，可重入、失败不阻断启动。

## Alternatives considered

- **judge 侧用 `BLMPOP` 多键阻塞**：Redis 6.2+ 支持按键顺序阻塞弹出，但弹出的消息需要再用 `LMOVE` 挪进 processing，两步之间崩溃会丢消息；`BRPOPLPUSH` 的原子语义更可靠。
- **固定 4:2:1 比例用「每轮 7 次阻塞」实现**：语义正确但空转代价高（700ms/轮）且 low 延迟大，故改为「非阻塞优先 + 单次阻塞兜底」。
- **优先级由客户端提交参数决定**：可被伪造，竞赛场景不可接受，改为服务端推导。
- **统一队列 + 权重调度**：需要在 Redis 侧维护额外状态，复杂度和一致性风险高于直接拆队列。
- **迁移旧队列时不补 priority**：旧消息缺少 `priority` 字段会导致 judge 反序列化失败进死信，故迁移时统一补 medium（不抬成 high，避免干扰进行中的竞赛）。
- **兼容双队列并行消费**：会长期维护两套协议，且 sweeper 需要同时扫描新旧 processing 列表，复杂度高；选择一次性迁移后彻底切换（core 与 judge 需同版本升级）。

## Consequences

- 竞赛提交获得优先评测，普通提交与重测仍能在有界时间内完成（每 7 次取任务至少取 1 次 low）；`33_priority_queue.test.ts` 增加 high 洪峰下 low 不被饿死的回归断言。
- 队列前缀现在真正贯通 core/judge，改错前缀的表现从「静默积压」变为「两侧一致（仍可能配错，但至少有单一事实源与文档约束）」。
- 升级需要 core 与 judge 同版本发布；旧队列中的在途任务由启动迁移兜底，无法解析的坏消息保留在旧列表等待人工处理。
- 每级独立容量上限使总上限从 20000 提升到 35000，Redis 内存占用上限相应提高；满队列时提交会被拒绝（HTTP 5xx/业务错误），不会静默丢弃。
- sweeper 重投与 judge 重投都变成原子操作，重复评测窗口收窄；仍保留 at-least-once 语义，由 `submission_id + rejudge_seq` 幂等吸收重复结果。
