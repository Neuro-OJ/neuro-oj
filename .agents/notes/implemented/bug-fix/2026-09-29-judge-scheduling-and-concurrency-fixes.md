# Agent Note: 评测机调度、并发伪锁与多副本状态治理（Batch 1）

Status: implemented

## Problem

在开赛前无人值守审查及第二轮审查中，识别出评测调度、并发处理及沙箱可用性层面的多项关键缺陷：
1. `AR-04`：`sweeper.ts` processing 队列超时重投使用 `RPUSH`，由于评测 Worker 采用 `BRPOPLPUSH` 从队列尾部（右侧）出队，导致超时任务反向插队队首，引发 poison pill 任务死锁消费者；
2. `AR-06`（决策 4）：提交语言枚举声明了 `cpp`, `c`, `javascript`，但双容器评测机仅支持 Python 3 运行时，导致非 Python 提交触发异常；
3. `AR-07`（决策 5）：评测程序执行总超时（Total Timeout）在 Rust 侧被粗暴归因为 `SystemError`，引发做题人对平台稳定性的误解；
4. `JA-01`：多个 Worker 挂载同一存储卷（Volume）时，直接读取 `WORK_DIR/.instance_id` 导致实例 ID 相同，启动清扫时互相杀害对方的容器并引发命名冲突；
5. `JA-02`：重测（Rejudge）在事务内先物理删除 `evaluationResults` 再向 Redis 队列推任务，若入队失败导致历史成绩物理丢失；
6. `JA-03`：评测机崩溃、OOM 或任务被强制 kill 时，临时下载的 `support-*.zip` 孤儿文件残留在 WorkDir 下，长期运行撑爆磁盘；
7. `CR-01`：`createSubmission` 和 `createArtifactSubmission` 在无显式事务块的情况下执行 `.for("update")` 单语句行锁，该锁随单语句提交瞬间释放，构成无效伪锁；
8. `CR-02`：提交路由在参数校验前先执行 `enforceSubmissionRateLimit`，格式错误或超长代码也白白扣减用户限流额度；
9. `CR-03`：`stats-cache.ts` 使用模块级内存变量存储提交总数与满分数，违背多副本约束。

## Decision

针对上述问题，实施以下统一工程修复：
1. **队列重投方向校正**：修改 `sweeper.ts` 的 Lua 脚本，将重投方向由 `RPUSH` 调整为 `LPUSH`，确保重投任务进入队列尾部排队，消灭队首插队死锁；
2. **提交语言契约收敛**：收敛 `LANGUAGE_EXT_MAP` 为仅支持 `python3` / `python`，其余语言提交统一返回 400 友好报错；
3. **超时归因规范化**：修改 `noj-judge/src/dual/mod.rs` 的 `finalize_outcome`，区分容器启动期超时（`Startup` 保持 `SystemError`）与评测执行期超时（`Total` 规范映射为 `TimeLimitExceeded`）；
4. **Volume 实例 ID 隔离**：修改 `resolve_instance_id`，持久化文件自动附加 `_{hostname}` 隔离后缀，防止多容器共用共享存储时冲突；
5. **成绩防丢失与幂等覆写**：重测发起时不再物理删除 `evaluationResults`，历史记录安全保留；新评测结果落库时在事务内幂等覆写；
6. **孤儿临时文件启动清扫**：在 `noj-judge/src/sandbox/cleanup.rs` 新增 `cleanup_orphan_support_packages`，启动时自动清扫残留的 `support-*.zip`；
7. **伪锁清除**：移除 `submissions-crud.ts` 与 `artifact-submissions.ts` 中的无事务 `.for("update")`，采用快照读取；
8. **校验前置与配额保护**：将提交限流统一后移到参数合法性校验通过之后；
9. **多副本状态 Redis 化**：重构 `stats-cache.ts`，基于 Redis 缓存（带 TTL）共享聚合统计，新结果到达时原子失效，兼顾多副本强一致与无 Redis 离线测试回退。

## Alternatives considered

- 保持 `stats-cache.ts` 纯 DB 查询：虽然消除了内存状态，但高并发下频繁 count(*) 会加重数据库负载，因此采用带有 10 秒 TTL 的 Redis 缓存模式。
- 在 `rejudge` 失败时回滚事务：由于 Redis 网络操作无法与数据库事务强一致，先不删除历史成绩并在落库时替换是更安全无副作用的设计。

## Consequences

- 评测机面对超时任务不再发生队首死锁，超时代码正确显示 TLE；
- 多 Worker 挂载同一共享目录时各自分配独立 instance ID，互不影响；
- 评测机重启和崩溃后自动清理临时 zip 文件，保障磁盘空间；
- 用户提交参数错误不再白扣提交配额，多副本下统计数据完全一致；
- 所有改动经 `deno task check`、`deno task test:domain`、`cargo check`、`cargo test` 验证通过。
