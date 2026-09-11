# Agent Note: 跨 worker 每用户 claim 的不变量校验、服务端时钟与 CI 覆盖

Status: implemented

## Problem

PR #488 把每用户并发限制从进程内集合改为 Redis 上的分布式 claim，方向正确，
但评审发现该机制的三条关键保障只存在于注释里，以及一处测试在 CI 中形同虚设：

1. **安全不变量无运行时校验。** per-user 互斥依赖「claim TTL > 单次评测最长可能耗时」。
   而 `JUDGE_MAX_EVALUATOR_TIME_MS` 接受任意 `u64`，`JUDGE_USER_CLAIM_TTL_MS` 独立配置，
   启动时不校验、不告警。运维把前者调到超过后者，长评测的 claim 会在跑完前被判过期
   并被其他 worker 回收 → 同一用户并发评测，**且难以察觉**：回收方不记录任何日志，
   受害方只在结束时打一条泛泛的"可能已过期"警告。这正是本 PR 要消灭的缺陷类型。
   更隐蔽的是 `JUDGE_MAX_EVALUATOR_TIME_MS=0` 表示**不设上限**（`clamp_runtime_config`
   的 `if max > 0`），此时任何有限 TTL 都不再受保障。

2. **时间戳取自调用方时钟。** claim 的 score 与过期cutoff 都由 worker 的
   `SystemTime` 计算并作为 ARGV 传入，脚本从不查询服务端时间。本机制是**跨主机**的，
   而多机部署里时钟漂移是常态：领先超过 TTL 的 worker 写下的 claim 会被其他 worker
   立即判为过期并回收，双方同时持有同一用户的 claim——互斥静默失效。
   此外 `now_ms()` 在系统时间异常时 `unwrap_or(0)`，写出的 score 为 0 会被任何
   正常时钟的 worker 立刻回收，即该 worker 的 claim 完全不起保护作用。

3. **最关键的回归证据在 CI 中不执行。** `tests/user_claim_redis.rs` 的守卫是
   `std::env::var("REDIS_URL").ok()?` → 直接 `return`。而 `judge-check`（唯一跑
   `nextest --all-targets` 的作业）**没有 Redis 服务**，`e2e.yml` 的 judge-sandbox
   虽提供 Redis 但目标列表不含该 binary。于是 6 个用例走 return 分支后被 nextest
   记为 **passed**——包括 `concurrent_claims_only_one_wins`（8 个 worker 争抢同一用户、
   恰好 1 个成功），即本 PR 的核心证据。仓库的静默跳过扫描器只识别 `#[ignore]` 与
   `is_e2e_enabled()`，识别不了这种写法。

另有两处实现细节问题：Lua 脚本的注释把 ARGV 顺序写成了与实际调用**不一致**的版本
（在原子性关键代码里，这种注释容易被"顺手改对"成 bug）；`count_active_claims` 名为
"count" 却用 `ZREMRANGEBYSCORE` **删数据**，失败时 `unwrap_or(())` 静默吞错。

## Decision

**1. 启动时校验不变量（`main.rs`）。**
- `TTL <= 评测上限` → `bail!` 拒绝启动，错误信息说明后果与修法（提到 ≥4 倍）；
- `TTL < 4 × 评测上限` → `warn!` 提示余量不足；
- `评测上限 == 0`（不设上限）→ `warn!` 明确"任何有限 TTL 都不再受保障"；
- 无论如何都 `info!` 打印命名空间前缀与 TTL，使"这一轮用的是哪个命名空间与 TTL"
  在日志里可查（队列改名会静默改变 claim 命名空间，需可追溯）。

**2. 时间基准移到 Redis 服务端（`user_claim.rs`）。** Lua 脚本内用 `TIME` 取
`{秒, 微秒}` 自行计算 `now`，调用方不再传时间。所有 worker 共用同一时间基准，
时钟漂移导致的失效从根上消失。顺带删除 `now_ms()`（不再有消费者）。

**3. 给 `judge-check` 加 Redis 服务并导出 `REDIS_URL`。** 用例在每次 CI 真实执行，
而不是"记为 passed"。同时把守卫的静默 `return` 改为打印显著提示，明确告知
"本用例未执行任何断言"及其运行方式。

**4. 修正脚本注释的 ARGV 顺序**，并在注释中标注"此处曾与调用不一致，勿凭记忆修改"。

**5. `count_active_claims` 改为只读**：用 `ZCOUNT key (now-ttl) +inf` 在脚本内取
服务端时间，不再删数据、不再吞错（`Result` 正常上抛）。

## Alternatives considered

- **让 claim 支持心跳续期（评审建议的 R1），从而降低对 TTL 的依赖。**
  方向正确，但属机制性改造：需要后台任务、额外的 Redis 往返、以及与优雅关闭的
  交互处理。本次先以「启动校验 + 服务端时钟」把**静默失效**堵住（这两项成本极低、
  收益明确），心跳作为后续独立改进。已在 Consequences 中记录其未做。
- **把 TTL 与评测上限合并为单一配置（由上限派生 TTL）。** 更省心，但会剥夺运维
  按部署规模分别调优的能力（如评测上限固定而希望 TTL 更短以加快崩溃恢复）。
  取"校验+告警"而非"强制派生"。
- **只加告警不拒绝启动。** 否决：该不变量被破坏时后果是**静默的公平性失效**，
  而配置错误发生在部署时——此时拒绝启动的代价（改一行配置）远小于上线后静默
  并发评测的代价。这是"配置不安全就 fail fast"的合理场景。
- **把 `user_claim_redis` 加进 `e2e.yml` 的目标列表（而非给 judge-check 加 Redis）。**
  也可行，但会让该用例只在 E2E 作业跑（更慢、且 e2e 的目标列表是给需要 Docker 的
  沙箱测试用的）；这些用例只依赖 Redis，放在 judge-check 里更快更贴切。
- **保留客户端时钟但校验 worker 间偏移。** 否决：需要额外的心跳与偏移跟踪机制，
  复杂度高于直接用服务端时间（后者是 Redis 的现成能力）。

## Consequences

- 配置不安全时**拒绝启动**；余量不足或不设评测上限时告警。配置错误不再静默地
  破坏每用户互斥。
- claim 的时间基准统一为 Redis 服务端时间，跨主机时钟漂移不再影响互斥
  （回归用例 `claim_score_uses_redis_server_clock` 从外部比对 score 与服务端 `TIME`；
  变异测试确认：改用偏移 1 小时的客户端时钟会立即失败）。
- 6 个 Redis 集成用例现在**每次 CI 都真实执行**（`judge-check` 提供 Redis 服务）；
  本地缺 `REDIS_URL` 时会打印"未执行任何断言"的显著提示。
- `count_active_claims` 变为只读，不再因为一次"查询"而删除数据。
- 未做（已记录，供后续排期）：
  - **claim 心跳/续期**——当前对崩溃恢复的代价是「用户最多被阻塞 TTL（默认 1h）」，
    因为 `instance_id` 默认含 pid，重启后无法清理前任的 claim；
  - **claim 回收/拒绝/错误的指标**——当前无可观测信号，运维无法判断是否发生过
    误回收（`decide` 的告警日志只在被回收方完成时打一条）；
  - **失败退避**——claim 路径出错时是固定 100ms 重试，Redis 持续异常时会形成
    约 10Hz 的重试循环且无区分指标。
