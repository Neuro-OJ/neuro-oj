# 面 1.1 复核结论（verifier 对抗性复核）

> 复核方式：**另派 verifier subagent**（finding 数 10 > 5，按 spec §5.4 门槛）
> 复核时间：2026-09-28 22:18 ｜ 复核员立场：尽力推翻每条 finding
> 假阳性率（证伪数 / 总数）= **1 / 10 = 10%**；部分证伪 5 条（结论保留但后果/归因被修正）

## 逐条裁定

| finding | 裁定 | 被修正的点 | 证据 |
|---|---|---|---|
| NOJ-A1 | **确认（机制）/ 后果部分证伪** | ① `WORK_DIR` 是**命名卷** `judge-cache:/tmp/noj-judge`（`docker-compose.prod.yml:230`），不是 tmpfs（`:240` 的 tmpfs 是容器 `/tmp`）→ OOM 来自 judge 进程 RSS 打到 2g，与 tmpfs 无关；② "单次提交即可 OOM" **夸大**：单任务峰值 ≈ 解压总量 512MiB + tar ≈512MiB ≈ **1.0GiB < 2g**，需 `JUDGE_MAX_CONCURRENT_JUDGES>=2`（默认 2）时两个高压缩比 artifact 的 `write_all` 窗口重叠才越界 → 属"有界放大、高概率叠加" | `dual/mod.rs:194-210`；`sandbox/container.rs:42-127,152-169,184-208`；`artifact-submissions.ts:177-210,281-293`；`routes/submissions.ts:180-195`；`docker-compose.prod.yml:181,230,240`；**实测压缩比 1030:1**（`zip -9` 压 512MB 全零 → 1000×512KB 条目，521,138B → 536,870,912B） |
| NOJ-A2 | **确认（注入期确实无超时）/ "permit 永久泄漏"部分证伪** | ① `inject_files_to_container` 内**无任何** `tokio::time::timeout`，两个调用点（`dual/mod.rs:208`、`:354`）也裸 await；`startup_deadline` 只在 `run_dual_loop` 内消费；② `docker.rs:15` 的 `connect_with_unix(sock, 120, ...)` 对 hijack 后的流**不生效**（bollard `execute_request` 只把超时包在响应头 future 上，`bollard-0.21.1/src/docker.rs:1681-1707`；`UnixConnector` 未设 socket 读写超时）→ `write_all` **可无限挂起**；③ 但 `/workspace` 写满会 ENOSPC → `tar` 非 0 退出 → EPIPE 解锁，**不会**因写满而挂起；④ permit **不是永久**泄漏（drain/重启会 abort），真实危害 = "1 个槽位被占满整个进程生命周期 + 该 `user_id` 被 claim 阻塞 3600s" | `sandbox/container.rs:176-225`（尤其 205-210）；`dual/container.rs:32-37,244-291`；`main.rs:264-279,375-432`；bollard 源码 |
| NOJ-A3 | **证伪** | "并发满员时已完成任务的 JoinHandle 只增不减"**不成立**：permit 获取（`main.rs:264-279`）与回收（`:438-442`）在**同一 loop body**，回收节拍 = 完成节拍；FuturesUnordered 长度被 permit 数（默认 2）封顶，有界。"无任务级 watchdog"这一观察成立，但只是 A2 的推论 | `main.rs:257,259-279,375-432,436-442` |
| NOJ-A4 | **部分确认（judge 侧严格）/ "存量任务每次 SystemError"证伪** | URL 是"先写 checksum、再由 `parseStorageUrl` 回读"的同源链路：三个 builder 全部调用点都传 `hashHex`（`s3.ts:107,217,328`、`local.ts:141,208,294`）；字段名两侧一致（`checksum_sha256`）；客户端写 `support_package_storage_url` 已被拒（`problems-crud.ts:81-86,318-323`）；`rg "noj-storage://"` 全仓无"缺 checksum 的构造点" → 缺少可达来源（仅手工改库/极旧数据可能） | `sandbox/download.rs:311-321,379`；`judge/runner.rs:169,197`；`noj-core` storage 层 |
| NOJ-A5 | **部分确认（抓到真缺陷，但归因错）** | "不可取消点导致孤儿容器"被兜底证伪：`main.rs:449-454` → `cleanup_containers_after_drain`（15s 有界、显式 await、按实例标签）存在。**真问题是 D3**：`drain_timeout_secs()=max(30, 下载超时+30)`（默认 90s，`config.rs:425-431`），而 prod compose 的 judge **无 `stop_grace_period`**（`rg stop_grace_period` 零命中）→ Docker 默认 10s 后 SIGKILL → drain 与其后 15s 兜底清扫**几乎总被跳过** | `drain.rs:13,26-45,54-105`；`main.rs:445-454`；`config.rs:425-431`；`docker-compose.prod.yml:178-248` |
| NOJ-A6 | **存疑** | 机制成立：`sweeper.ts:284` 的 `?? ""` 在 `recoverPendingRows` 内；**self_tests 路径的 select 里根本没有 user_id**（`:398-410`）→ 每次自测恢复的任务都是 `user_id:""`；`user_id` 列是 NOT NULL+FK（非 NULL 来源）；claim key `{prefix}:active_users:` 尾部空 → 空串任务共享同一 key。但"无限重投饿死"**未证**：任务会跑完并释放 claim，且 `enforceSelfTestRateLimit` = 4 次/60s/用户 → 是吞吐退化而非永久饿死 | `sweeper.ts:281-295,345,398-410`；`schema/submission.ts:37,119-121`；`user_claim.rs:40-42,67-112`；`hardening-rate-limit.ts:42-60` |
| NOJ-A7 | **确认 / "参赛者可控放大"夸大** | 连接确实不池化（`mq.rs:158-179,184-203,230` 每次 `get_multiplexed_async_connection`；bollard 侧 `pool_max_idle_per_host(0)`）。**新发现（比原 finding 更锋利）**：`REQUEUE_SCRIPT` 用 `RPUSH`，而主循环用 `LREM processing + RPOPLPUSH`（同端）→ 重投的消息**立刻又是下一个弹出候选**，比"放回队尾"更热 | `mq.rs:150-179`；`main.rs:337-350`；`producer.ts:16-41` |
| NOJ-A8 | **部分确认 / "永不被清理"证伪** | `create_container` 30s 客户端超时分支确实拿不到 ID（无清理点），但容器带实例标签 + 实例 ID 确定性 → **最近一次重启的启动清扫必回收**；且 start 失败/5s 超时已有显式 `remove_container_force`（`dual/container.rs:277-288`）。真实残留窗口仅"daemon 已创建但客户端已超时"这一狭窄情形 | `dual/container.rs:272-291`；`cleanup.rs:101-131`；`config.rs:229-265` |
| NOJ-A9 | **确认**（卫生项，未缓解） | `rg "dead"` 仅 `mq.rs:58-60` 一处 `LPUSH`，无 `LTRIM`/`EXPIRE`/消费者；影响仅限"坏消息永不清理" | `mq.rs:52-63,378-392` |
| NOJ-A10 | **确认（可达性依赖 `--scale`）** | 后果应修正为"**结果被覆盖为 error 终态**"而非"丢失"（同伴容器被删 → SystemError → `push_succeeded=true` → `ack_task`，`main.rs:417-428`）；触发前提（多副本共享卷）在生产默认单副本下不成立，`--scale judge=N` 时命中（judge 服务**无 `container_name`**、无 `JUDGE_INSTANCE_ID`） | `config.rs:219-265`；`cleanup.rs:31-38,101-131`；`docker-compose.prod.yml:178-248`；`main.rs:417-428` |

## 一审漏掉的缺陷（verifier 独立发现）

- **D1（中高，单人可触发、跨用户）**：artifact 的**压缩体积**上限（`DEFAULT_ARTIFACT_MAX_SIZE_BYTES = 2GiB`，`artifact-submissions.ts:46,177-181`）与 judge 内存预算完全脱钩——judge 侧只有解压总量 512MiB 与 `mem_limit 2g`，两侧**无任何启动期不变量校验**。实测压缩比 1030:1 → "合法大小的上传"即可让 judge RSS 冲 ≈1.0GiB；并发窗口重叠即 ≈2.0GiB OOM。建议：core 侧按题目声明"解压后总量上限"，或 judge 侧改流式；并加 `JUDGE_MEM_LIMIT` 与 `MAX_TOTAL_SIZE × (并发数+1)` 的启动期校验。
- **D2（中，把崩溃放大成 1 小时不可用）**：`try_claim_user` 只在新 claim 到来时清理过期成员（`user_claim.rs:86-97`），TTL 默认 3,600,000ms（`config.rs:290`）。judge 被 OOM-kill/强杀时 `ActiveUserGuard`（`main.rs:68-85`）的 Drop 来不及 release → 该用户 claim 在 3600s 内一直有效 → sweeper 重投后新 judge 拉取恒 false → 每 100ms 空转重投（叠加 A7 的连接 churn），该用户所有提交在此窗口内均不可评。member 已含 `{instance_id}:{submission_id}`（`user_claim.rs:45-47`）→ 天然可按实例前缀回收。
- **D3（中，部署面）**：`stop_grace_period` 未设置 → 优雅关闭在默认 compose 下不可达（见 A5 行）。

## verifier 明确排除的候选（说明确实筛过）

- `inject_files_to_container` 的 `create_exec` 无超时：在 bollard 120s 请求超时内、失败任务是自己的，影响面小。
- `sandbox/cache.rs` 的 `get_path` 释放锁后文件可能被并发 LRU 淘汰 → `read_to_end` I/O 失败：跨用户、可重试，但需缓存接近 `SUPPORT_CACHE_MAX_MB`，证据强度不足，列入待实测。

## 待实测清单（进入 Task 1 Step 4）

1. **A1 峰值与是否真 OOM**（最关键）：构造 bomb.zip → 提交 → `docker stats` RSS 峰值 / `docker inspect State.OOMKilled`；同时发他人正常提交观察是否 `SystemError`。判定：单任务峰值 <1.2GiB 且不 OOM ⇒ A1 降级为"并发叠加才触发"。
2. **A2 `write_all` 是否真能无限挂起**：容器内让 `tar xf -` 停读 stdin（或 SIGSTOP），观察任务是否卡 >5min、`active_tasks` 是否长期不降。
3. **A6 空 user_id 共享 claim**：连造 2–3 条 self_tests pending 行，观察是否"重投风暴"、他人任务是否仍被处理。
4. **A10 多副本互杀**：`--scale judge=2` + 重启 B，观察 A 的在跑容器是否被删、提交是否 error。
5. **A9 死信增长**：注入坏 JSON，看 `LLEN :dead` 只增不减。
6. **A7 churn 量化**：`redis-cli info clients` 在单用户洪水下的曲线；确认 `RPUSH` 后同一任务是否被立即再次弹出。

> verifier 声明：未执行 docker/cargo（只读约束）；A1 的压缩比样本在临时目录构造后已删除，未触碰仓库文件；工作区未做任何修改。
